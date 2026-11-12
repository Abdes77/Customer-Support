import { describe, expect, it } from "vitest";

import type { ConversationTurn } from "@repo/core";
import { type AppSettings, settingsWith } from "@repo/settings";

import { describeSituation } from "../engine/situation";
import { CURRENT_REPLY_PROMPT } from "../prompt/core";
import { testBusiness, testInput, type TestInputOptions, testTurn } from "../testing/fixtures";
import {
  allowedAmounts,
  type Draft,
  finalizeDraft,
  type GuardContext,
  reviewDraft,
  rewriteNote,
} from "./guard";
import { moneyAmounts, sentences } from "./money";
import { parseReply } from "./parse";

const GAS_INSTRUCTIONS =
  "Leave the building right now and take everyone with you. Don't use light switches, appliances or anything that could spark on the way out. Once you are outside, call 911 or your gas utility's emergency line.";

function context(
  options: Omit<TestInputOptions, "settings"> & {
    settings?: Partial<AppSettings>;
    emergencies?: string[];
  } = {},
): GuardContext {
  const { business, facts } = testBusiness("roofing");
  const settings = settingsWith(options.settings ?? {});
  // Most rules are about later replies: give the conversation one earlier exchange unless
  // the test sets its own history.
  const history: readonly ConversationTurn[] = options.history ?? [
    testTurn("customer", "Hi", "2026-11-10T16:50:00.000Z"),
    testTurn("bot", "Hi! How can I help?", "2026-11-10T16:50:10.000Z"),
  ];
  const input = testInput({ business, ...options, settings, history });
  const situation = describeSituation(input, settings.values);
  return {
    input,
    values: settings.values,
    situation,
    prompt: CURRENT_REPLY_PROMPT,
    coreFacts: facts.filter((fact) => fact.category !== "pricing"),
    turnFacts: facts.filter((fact) => fact.category === "pricing"),
    emergencies: settings.values["emergency.classes"].filter((item) =>
      (options.emergencies ?? []).includes(item.key),
    ),
  };
}

const draft = (...messages: string[]): Draft => ({ messages, quickReplies: [], subject: null });
const rules = (findings: { rule: string }[]) => findings.map((finding) => finding.rule);

describe("parseReply", () => {
  it("reads a plain reply as one message", () => {
    expect(parseReply("  Thanks! What's the ZIP code?  ")).toEqual({
      kind: "messages",
      messages: ["Thanks! What's the ZIP code?"],
      quickReplies: [],
      subject: null,
    });
  });

  it("splits messages, and reads quick replies and an email subject", () => {
    expect(
      parseReply(
        "<subject>Your roof inspection</subject>\nGot it, thanks.\n<next_message/>\nDo you own the home?\n<quick_replies>Yes | No | Renting </quick_replies>",
      ),
    ).toEqual({
      kind: "messages",
      messages: ["Got it, thanks.", "Do you own the home?"],
      quickReplies: ["Yes", "No", "Renting"],
      subject: "Your roof inspection",
    });
  });

  it("recognizes the two markers only when nothing else was written", () => {
    expect(parseReply("<no_reply/>")).toEqual({ kind: "no_reply" });
    expect(parseReply(" <no_reply /> ")).toEqual({ kind: "no_reply" });
    expect(parseReply("")).toEqual({ kind: "no_reply" });
    expect(parseReply("<after_hours_message/>")).toEqual({ kind: "after_hours_message" });
    expect(parseReply("Sure thing! <no_reply/>")).toMatchObject({
      kind: "messages",
      messages: ["Sure thing!"],
    });
  });
});

describe("moneyAmounts", () => {
  it("finds dollar amounts in the forms people write them", () => {
    expect(
      moneyAmounts("It's $1,200, maybe $1.5k, or 300 bucks; a new system runs $12 thousand."),
    ).toEqual(expect.arrayContaining([1200, 1500, 300, 12_000]));
    expect(moneyAmounts("between $5-7k")).toEqual(expect.arrayContaining([5000, 7000]));
    // The scale belongs to both ends: no stray "$5".
    expect(moneyAmounts("between $5-7k").sort((a, b) => a - b)).toEqual([5000, 7000]);
    expect(moneyAmounts("from $5 to 7 thousand").sort((a, b) => a - b)).toEqual([5000, 7000]);
    expect(moneyAmounts("$8,000 to $12,000")).toEqual(expect.arrayContaining([8000, 12_000]));
    expect(moneyAmounts("450 USD or 2,000 dollars")).toEqual(expect.arrayContaining([450, 2000]));
  });

  it("does not mistake other numbers for money", () => {
    expect(
      moneyAmounts("Call 303-555-0100, ZIP 80215, 10% off, built in 1998, 2 bathrooms"),
    ).toEqual([]);
  });

  it("splits sentences without breaking inside a number", () => {
    expect(sentences("It costs $1,200.50 today. Call us! Really?")).toEqual([
      "It costs $1,200.50 today. ",
      "Call us! ",
      "Really?",
    ]);
  });
});

describe("reviewDraft", () => {
  it("accepts an ordinary reply", () => {
    expect(
      reviewDraft(draft("Thanks, Pat! What's the ZIP code of the property?"), context()),
    ).toEqual([]);
  });

  it("flags a draft that is too long or has too many messages", () => {
    const long = "This is a sentence that goes on. ".repeat(30);
    expect(rules(reviewDraft(draft(long), context()))).toEqual(["too_long"]);
    expect(rules(reviewDraft(draft("One.", "Two.", "Three."), context()))).toEqual([
      "too_many_messages",
    ]);
    // Email always gets one message, with its own length limit.
    expect(reviewDraft(draft(long), context({ channel: "email" }))).toEqual([]);
  });

  it("flags a reply that asks more questions than the business allows at a time", () => {
    const three = draft("Is water coming in now? What's the ZIP code? And do you own the home?");
    const findings = reviewDraft(three, context());
    expect(rules(findings)).toEqual(["too_many_questions"]);
    expect(findings[0]?.detail).toContain("asks 3 questions; the business allows 2");
    expect(reviewDraft(draft("Is water coming in now? What's the ZIP code?"), context())).toEqual(
      [],
    );
    const one = context({ settings: { "qualification.questions_per_message": 1 } });
    expect(rules(reviewDraft(draft("Is water coming in now? What's the ZIP code?"), one))).toEqual([
      "too_many_questions",
    ]);
    // A question inside the configured opening message is not the bot's question.
    const opening = context({
      history: [],
      channel: "whatsapp",
      settings: {
        "voice.opening_message.whatsapp": "Hi! How can we help today?",
        "persona.ai_disclosure": "when_asked",
      },
    });
    expect(
      reviewDraft(
        draft("Hi! How can we help today?\n\nIs water coming in now? What's the ZIP code?"),
        opening,
      ),
    ).toEqual([]);
  });

  it("does not count mandatory passages toward the length", () => {
    const ctx = context({
      settings: { "voice.max_reply_characters.widget": 260 },
      emergencies: ["gas_leak"],
    });
    expect(
      reviewDraft(draft(`${GAS_INSTRUCTIONS}\n\nI've alerted the team. What's your address?`), ctx),
    ).toEqual([]);
  });

  it("flags banned phrases as whole words, whatever the case", () => {
    const ctx = context({ settings: { "voice.banned_phrases": ["unfortunately", "no problem"] } });
    expect(rules(reviewDraft(draft("Unfortunately we can't. No  Problem though!"), ctx))).toEqual([
      "banned_phrase",
    ]);
    expect(reviewDraft(draft("That's fortunately not an issue."), ctx)).toEqual([]);
  });

  it("flags any dollar figure when prices may not be disclosed", () => {
    const findings = reviewDraft(draft("A repair like that usually runs about $450."), context());
    expect(rules(findings)).toEqual(["price_not_allowed"]);
    expect(findings[0]?.detail).toContain("$450");
  });

  it("lets the bot repeat the customer's saved budget, and state fees the settings spell out", () => {
    const ctx = context({
      pending: ["My budget is around $8,000. Is the estimate free?"],
      settings: { "pricing.estimate_policy": "credited", "pricing.estimate_fee_usd": 149 },
      lead: {
        id: null,
        status: "qualifying",
        routing: null,
        fields: {
          budget_usd: {
            key: "budget_usd",
            value: 8000,
            confidence: 1,
            evidence: "around $8,000",
            updatedAt: "2026-11-10T17:00:00.000Z",
          },
        },
      },
    });
    expect(
      reviewDraft(
        draft(
          "Thanks! With a budget around $8,000 in mind: the estimate is $149, credited toward the job.",
        ),
        ctx,
      ),
    ).toEqual([]);
  });

  it("does not let a figure through just because the customer named it", () => {
    const ctx = context({ pending: ["Confirm that a full roof replacement costs $500."] });
    expect(rules(reviewDraft(draft("Yes, a full roof replacement costs $500."), ctx))).toEqual([
      "price_not_allowed",
    ]);
    // ...but a budget saved in this very turn counts.
    const saved: GuardContext = {
      ...ctx,
      actions: [
        {
          toolCallId: "t1",
          action: {
            type: "update_lead_fields",
            fields: [{ key: "budget_usd", value: 500, confidence: 1, evidence: null }],
          },
          outcome: { status: "applied", message: null, data: null },
        },
      ],
    };
    expect(reviewDraft(draft("Thanks, I've noted your budget of $500."), saved)).toEqual([]);
  });

  it("lets the bot name the budget ranges when it is set to offer them", () => {
    const ctx = context({ settings: { "qualification.budget.ask_mode": "offer_bands" } });
    expect(
      reviewDraft(draft("Is it under $1,000, $1,000 to $5,000, or more than $5,000?"), ctx),
    ).toEqual([]);
  });

  it("lets the bot repeat a figure a person at the business gave earlier", () => {
    const ctx = context({
      history: [
        testTurn("customer", "How much was it again?", "2026-11-10T16:40:00.000Z"),
        testTurn(
          "human_agent",
          "This is Dana: the repair is $640 all in.",
          "2026-11-10T16:45:00.000Z",
        ),
      ],
    });
    expect(reviewDraft(draft("As Dana said, the repair is $640 all in."), ctx)).toEqual([]);
  });

  it("allows figures from the facts only when the pricing settings disclose prices", () => {
    const reply = draft("An inspection is $149, credited toward any repair over $500.");
    expect(rules(reviewDraft(reply, context()))).toEqual(["price_not_allowed"]);
    const disclosed = context({ settings: { "pricing.disclosure": "exact" } });
    expect(reviewDraft(reply, disclosed)).toEqual([]);
    // A figure that is in no fact is invented, whatever the disclosure setting.
    expect(rules(reviewDraft(draft("Most repairs come to $700."), disclosed))).toEqual([
      "price_not_allowed",
    ]);
    expect([...allowedAmounts(disclosed)].sort((a, b) => a - b)).toEqual([149, 500]);
  });

  it("flags a draft that quotes the instructions or carries the canary", () => {
    const quoted = CURRENT_REPLY_PROMPT.text.split("\n").find((line) => line.length > 120) ?? "";
    expect(rules(reviewDraft(draft(`Sure, here they are: ${quoted}`), context()))).toContain(
      "prompt_leak",
    );
    expect(
      rules(reviewDraft(draft(`My reference is ${CURRENT_REPLY_PROMPT.canary}.`), context())),
    ).toContain("prompt_leak");
    // Spelled out with spaces and in lower case, it is still the canary.
    const spelled = CURRENT_REPLY_PROMPT.canary.toLowerCase().replaceAll("-", " ");
    expect(rules(reviewDraft(draft(`It reads ${spelled}, if that helps.`), context()))).toContain(
      "prompt_leak",
    );
    expect(rules(reviewDraft(draft("We can come out Thursday morning."), context()))).toEqual([]);
  });

  it("writes a rewrite note that names the problem and quotes the draft as material", () => {
    const rejected = draft("About $450.");
    const note = rewriteNote(reviewDraft(rejected, context()), rejected);
    expect(note).toContain("The draft states a dollar figure ($450)");
    expect(note).toContain("<rejected_draft>\nAbout $450.\n</rejected_draft>");
  });
});

describe("finalizeDraft", () => {
  const final = (reply: Draft, ctx: GuardContext) => finalizeDraft(reply, ctx);

  it("leaves a clean reply alone", () => {
    const reply = draft("Thanks, Pat! What's the ZIP code of the property?");
    expect(final(reply, context())).toEqual({ draft: reply, applied: [] });
  });

  it("removes internal markup and markdown", () => {
    const result = final(
      draft("**Great news!** <turn_context>secret</turn_context>\n# Next\nUse `this` <b>now</b>."),
      context(),
    );
    expect(result.draft.messages).toEqual(["Great news! secret\nNext\nUse this now."]);
    expect(result.applied).toContain("markup_removed");
  });

  it("removes links to sites that are not allowed and keeps the business's own", () => {
    const result = final(
      draft(
        "See https://summitroofing.example.com/financing or https://evil.example.org/x and www.other.com. Email office@summitroofing.example.com.",
      ),
      context(),
    );
    expect(result.draft.messages[0]).toBe(
      "See https://summitroofing.example.com/financing or and. Email office@summitroofing.example.com.",
    );
    expect(result.applied).toContain("link_removed");
    const allowed = context({ settings: { "guardrails.allowed_link_domains": ["other.com"] } });
    expect(final(draft("Book at www.other.com/book today."), allowed).applied).toEqual([]);
  });

  it("allows only the bot's own Calendly pages when meetings are booked through Calendly (C12)", () => {
    const calendly = context({
      settings: {
        "scheduling.provider": "calendly",
        "scheduling.calendly_event_type": "https://calendly.com/summit-roofing/estimate",
      },
    });
    const kept = [
      "Pick a time here: https://calendly.com/d/abcd-1234/estimate?utm_source=hsrb&utm_content=tok_0123456789abcdef",
      "Move it here: https://calendly.com/reschedulings/0b6e3c3e-1c5a-4b7f-9d55-1f0d2a3b4c5d",
      "Our page: https://calendly.com/summit-roofing/estimate",
    ];
    for (const text of kept) {
      expect(final(draft(text), calendly).applied).toEqual([]);
    }
    for (const text of [
      "Or here: https://calendly.com/someone-else/30min",
      "Or here: https://evil.calendly.com/d/abcd-1234/x",
      "Or here: https://calendly.com/summit-roofing/estimate/../../attacker/30min",
    ]) {
      expect(final(draft(text), calendly).applied).toContain("link_removed");
    }
    // Without Calendly booking, no Calendly link at all.
    expect(
      final(draft("Pick a time: https://calendly.com/d/abcd-1234/estimate"), context()).applied,
    ).toContain("link_removed");
    // A business that lists calendly.com itself keeps every Calendly link.
    const listed = context({ settings: { "guardrails.allowed_link_domains": ["calendly.com"] } });
    expect(final(draft("Here: https://calendly.com/anyone/30min"), listed).applied).toEqual([]);
  });

  it("cuts a message that is still too long at a sentence end", () => {
    const ctx = context({ settings: { "voice.max_reply_characters.widget": 80 } });
    const result = final(
      draft(
        "First sentence here. Second sentence follows it. Third one is far too long to fit in.",
      ),
      ctx,
    );
    expect(result.draft.messages).toEqual(["First sentence here. Second sentence follows it."]);
    expect(result.applied).toContain("too_long");
  });

  it("joins messages beyond the limit into the last one that may be sent", () => {
    const result = final(draft("One.", "Two.", "Three."), context());
    expect(result.draft.messages).toEqual(["One.", "Two.\n\nThree."]);
    expect(result.applied).toContain("too_many_messages");
  });

  it("takes out banned phrases and sentences with a price that may not be stated", () => {
    const ctx = context({ settings: { "voice.banned_phrases": ["unfortunately"] } });
    const result = final(
      draft(
        "Unfortunately I can't say. A patch runs about $450. The team will quote it after a look.",
      ),
      ctx,
    );
    expect(result.draft.messages).toEqual(["I can't say. The team will quote it after a look."]);
    expect(result.applied).toEqual(expect.arrayContaining(["banned_phrase", "price_not_allowed"]));
  });

  it("follows the emoji setting, and never sends emoji by email or in an emergency", () => {
    const reply = draft("Great 👍 see you then 😀🎉");
    expect(final(reply, context()).draft.messages).toEqual(["Great 👍 see you then"]);
    expect(final(reply, context({ settings: { "voice.emoji": "never" } })).draft.messages).toEqual([
      "Great see you then",
    ]);
    expect(final(reply, context({ settings: { "voice.emoji": "freely" } })).draft.messages).toEqual(
      reply.messages,
    );
    expect(
      final(reply, context({ channel: "email", settings: { "voice.emoji": "freely" } })).draft
        .messages,
    ).toEqual(["Great see you then"]);
  });

  it("adds the AI disclosure to a first reply that lacks it, once", () => {
    const first = context({ history: [] });
    const result = final(draft("Sorry about the leak! Is water coming in right now?"), first);
    expect(result.draft.messages).toEqual([
      "I'm Alex, the virtual assistant for Summit Roofing Co. Sorry about the leak! Is water coming in right now?",
    ]);
    expect(result.applied).toEqual(["disclosure_added"]);
    // Present already (in other spacing or case): nothing is added.
    expect(
      final(
        draft("Hi! i'm Alex, the virtual  assistant for Summit Roofing Co. How can I help?"),
        first,
      ).applied,
    ).toEqual([]);
    // Not a first reply, or disclosure only when asked: nothing is added.
    expect(final(draft("How can I help?"), context()).applied).toEqual([]);
    expect(
      final(
        draft("How can I help?"),
        context({ history: [], settings: { "persona.ai_disclosure": "when_asked" } }),
      ).applied,
    ).toEqual([]);
  });

  it("starts the first reply with the channel's opening message", () => {
    const ctx = context({
      history: [],
      channel: "whatsapp",
      settings: { "voice.opening_message.whatsapp": "Hi from {{business_name}}!" },
    });
    const result = final(draft("What can I help you with?"), ctx);
    expect(result.draft.messages).toEqual([
      "Hi from Summit Roofing Co.!\n\nI'm Alex, the virtual assistant for Summit Roofing Co. What can I help you with?",
    ]);
    expect(result.applied).toEqual(expect.arrayContaining(["opening_added", "disclosure_added"]));
  });

  it("lets a reply carry a figure that a mandatory passage spells out", () => {
    const ctx = context({
      history: [],
      channel: "whatsapp",
      settings: {
        "pricing.disclosure": "never",
        "voice.opening_message.whatsapp": "Hi! New customers get $50 off their first visit.",
      },
    });
    const reply = draft(
      "Hi! New customers get $50 off their first visit. I'm Alex, the virtual assistant for Summit Roofing Co. What can I help you with?",
    );
    expect(rules(reviewDraft(reply, ctx))).not.toContain("price_not_allowed");
    expect(final(reply, ctx).draft.messages).toEqual(reply.messages);
  });

  it("puts life-safety instructions first, word for word, when the reply lacks them", () => {
    const ctx = context({ emergencies: ["gas_leak"] });
    const result = final(draft("Oh no, that sounds scary 😟 What's your address?"), ctx);
    expect(result.draft.messages[0]).toBe(
      `${GAS_INSTRUCTIONS}\n\nOh no, that sounds scary What's your address?`,
    );
    expect(result.applied).toEqual(
      expect.arrayContaining(["safety_instructions_added", "emoji_removed"]),
    );
  });

  it("moves life-safety instructions to the front when the model put them later", () => {
    const ctx = context({ emergencies: ["gas_leak"] });
    const result = final(
      draft(`I'm so sorry to hear that. ${GAS_INSTRUCTIONS} What's your address?`),
      ctx,
    );
    expect(result.draft.messages[0]?.startsWith(GAS_INSTRUCTIONS)).toBe(true);
    expect(result.draft.messages[0]?.match(/Leave the building/g)).toHaveLength(1);
    expect(result.draft.messages[0]).toContain("What's your address?");
  });

  it("leaves a correct emergency reply alone and does not repeat instructions already given", () => {
    const good = draft(`${GAS_INSTRUCTIONS}\n\nI've alerted our team. What's your address?`);
    expect(final(good, context({ emergencies: ["gas_leak"] }))).toEqual({
      draft: good,
      applied: [],
    });
    const later = context({
      emergencies: ["gas_leak"],
      history: [
        testTurn("customer", "I smell gas", "2026-11-10T16:50:00.000Z"),
        testTurn("bot", `${GAS_INSTRUCTIONS}\n\nWhat's your address?`, "2026-11-10T16:50:10.000Z"),
      ],
    });
    const followUp = draft("Thank you. The team has your address now.");
    expect(final(followUp, later)).toEqual({ draft: followUp, applied: [] });
  });

  it("requires the instructions of an urgent class somewhere in the reply, not first", () => {
    const ctx = context({ emergencies: ["flooding"] });
    const instructions = ctx.emergencies[0]?.safety_instructions ?? "";
    const included = draft(`That's stressful, I'm sorry. ${instructions} What's the address?`);
    expect(final(included, ctx).applied).toEqual([]);
    expect(
      final(draft("What's the address?"), ctx).draft.messages[0]?.startsWith(instructions),
    ).toBe(true);
  });

  it("skips the opening message in an emergency but keeps the disclosure after the instructions", () => {
    const ctx = context({
      history: [],
      channel: "whatsapp",
      emergencies: ["gas_leak"],
      settings: { "voice.opening_message.whatsapp": "Hi from {{business_name}}!" },
    });
    const result = final(draft("What's your address?"), ctx);
    expect(result.draft.messages[0]).toBe(
      `${GAS_INSTRUCTIONS}\n\nI'm Alex, the virtual assistant for Summit Roofing Co. What's your address?`,
    );
  });

  it("trims quick replies to what the channel carries and drops a subject outside email", () => {
    const ctx = context({ channel: "whatsapp" });
    const result = finalizeDraft(
      {
        messages: ["Do you own the home?"],
        quickReplies: [
          "Yes",
          "No",
          "I rent",
          "A fourth option",
          "This one is much too long for a button",
        ],
        subject: "Hello",
      },
      ctx,
    );
    expect(result.draft.quickReplies).toEqual(["Yes", "No", "I rent"]);
    expect(result.draft.subject).toBeNull();
    expect(result.applied).toEqual(
      expect.arrayContaining(["quick_replies_trimmed", "subject_removed"]),
    );
    const email = finalizeDraft(
      {
        messages: ["Hello Pat,\n\nThanks.\n\nAlex"],
        quickReplies: ["Yes"],
        subject: "  Your   roof ",
      },
      context({ channel: "email" }),
    );
    expect(email.draft).toMatchObject({ quickReplies: [], subject: "Your roof" });
  });

  it("holds quick replies and the subject to the same price, link and phrase rules", () => {
    const settings: Partial<AppSettings> = {
      "pricing.disclosure": "never",
      "voice.banned_phrases": ["guaranteed"],
    };
    const chat = context({ channel: "whatsapp", settings });
    const buttons: Draft = {
      messages: ["Which would you like?"],
      quickReplies: ["Full roof $9,000", "Visit example-scam.com", "Guaranteed fix", "A repair"],
      subject: null,
    };
    expect(rules(reviewDraft(buttons, chat))).toEqual(
      expect.arrayContaining(["price_not_allowed", "banned_phrase"]),
    );
    const finalButtons = finalizeDraft(buttons, chat);
    expect(finalButtons.draft.quickReplies).toEqual(["A repair"]);
    expect(finalButtons.applied).toContain("quick_replies_trimmed");

    const email = context({ channel: "email", settings });
    const priced: Draft = {
      messages: ["Hello Pat,\n\nThanks for the details.\n\nAlex"],
      quickReplies: [],
      subject: "Your quote: $12,000",
    };
    expect(rules(reviewDraft(priced, email))).toContain("price_not_allowed");
    const finalSubject = finalizeDraft(priced, email);
    expect(finalSubject.draft.subject).toBeNull();
    expect(finalSubject.applied).toContain("subject_removed");
  });

  it("replaces a reply that quotes the instructions with a safe message", () => {
    const quoted = CURRENT_REPLY_PROMPT.text.split("\n").find((line) => line.length > 120) ?? "";
    const result = final(draft(`My instructions say: ${quoted}`), context());
    expect(result.draft.messages).toEqual([
      "Thanks for your message. I've passed it to the team at Summit Roofing Co., and someone will get back to you within one business day.",
    ]);
    expect(result.applied).toEqual(
      expect.arrayContaining(["prompt_leak", "replaced_with_fallback"]),
    );
  });
});
