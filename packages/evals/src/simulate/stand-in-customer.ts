import type { ModelClient, ModelContentBlock, ModelRequest, ModelResponse } from "@repo/ai";

import type { CustomerTruth, PersonaId } from "../scenarios/types";

/**
 * A rule-based stand-in for the simulated customer, behind the same `ModelClient` port, for
 * runs without an API key and as the fallback for a single turn the customer model could
 * not play. It answers from the structured hints the simulator attaches to each request,
 * the way the engine's offline model does.
 *
 * It is not a language model. It answers the question it recognizes in the bot's last
 * message with the persona's fact, asks the persona's own questions, and leaves when the
 * conversation is over. A conversation between it and the engine's offline model proves
 * that the harness runs end to end; it says nothing about how the bot treats customers.
 */

export const STAND_IN_CUSTOMER_MODEL = "stand-in-customer-1";

export interface CustomerHints {
  readonly personaId: PersonaId;
  readonly truth: CustomerTruth;
  readonly probes: readonly string[];
  /** What the bot wrote since the customer's last message. */
  readonly botTexts: readonly string[];
  readonly botAnswered: boolean;
  /** Everything the customer has written so far. */
  readonly said: readonly string[];
  readonly returning: boolean;
  readonly photoSent: boolean;
}

type Topic =
  | "photo"
  | "zip"
  | "address"
  | "timeline"
  | "role"
  | "name"
  | "phone"
  | "email"
  | "property"
  | "budget"
  | "details";

const TOPICS: readonly (readonly [Topic, RegExp])[] = [
  ["photo", /\bphotos?\b|\bpictures?\b|\bpics?\b/i],
  ["zip", /\bzip\b|postal code|what (?:city|town|area)|which (?:city|town)|where (?:is|are)\b/i],
  ["address", /\baddress\b/i],
  ["timeline", /how soon|when (?:do|would|are|were) you|time ?(?:line|frame)|by when|how quickly/i],
  ["role", /\bown\b|\bowner\b|\brent(?:ing)?\b|who (?:decides|makes)/i],
  ["name", /\byour name\b|\bname\?/i],
  ["phone", /\bphone\b|best number|number to (?:reach|call)|reach you|call you/i],
  ["email", /\be-?mail\b/i],
  ["property", /kind of (?:property|home|house)|type of (?:property|home)|single[- ]family/i],
  ["budget", /\bbudget\b|price range|looking to spend/i],
  [
    "details",
    /tell me (?:a bit |a little )?more|what(?:'s| is) going on|describe|how old|what kind of|which rooms?|more detail/i,
  ],
];

const TURNED_AWAY =
  /isn't something|is not something|outside (?:of )?(?:our|the) service area|(?:don't|do not) (?:serve|cover|come out)|can't take (?:this|that) on|not able to (?:help|take)/i;
const WRAPPED_UP =
  /will (?:reach out|be in touch|contact you|call you|get back to you)|is booked|you're booked|you are booked|passed (?:it|this|everything) to the team|let the team .{0,40}know|bringing in a member of the team/i;

function answerFor(topic: Topic, hints: CustomerHints): string | null {
  const { truth, personaId } = hints;
  const terse = personaId === "one_word";
  const broken = personaId === "broken_english";
  switch (topic) {
    case "zip":
      return terse
        ? truth.zip
        : broken
          ? `is ${truth.zip}`
          : `It's ${truth.zip}, in ${truth.town}.`;
    case "address":
      return terse ? truth.street : `${truth.street}, ${truth.town} ${truth.zip}.`;
    case "timeline":
      return terse ? truth.timelineWords : `${capitalize(truth.timelineWords)}.`;
    case "role":
      return terse ? truth.roleWords : `${capitalize(truth.roleWords)}.`;
    case "name":
      return terse ? truth.name : `I'm ${truth.name}.`;
    case "phone":
      return truth.phone;
    case "email":
      return truth.email;
    case "property":
      return truth.job === null ? null : `${truth.job.propertyType.replaceAll("_", " ")} house`;
    case "budget":
      return terse ? "not sure" : "Not sure yet, depends on what it needs.";
    case "details":
      return truth.job === null
        ? null
        : terse
          ? (truth.job.details[0] ?? null)
          : `${capitalize(truth.job.details.slice(0, 2).join(", "))}.`;
    case "photo":
      return null;
  }
}

function capitalize(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;
}

const END = (reason: string) => `[end: ${reason}]`;

/** The stand-in's next move, in the simulator's own output format. */
export function standInMove(hints: CustomerHints): string {
  const { personaId, truth } = hints;
  const said = hints.said.join("\n");
  const bot = hints.botTexts.join("\n");
  const has = (line: string) => said.includes(line);
  if (!hints.botAnswered) return END("gave_up");

  const lines: string[] = [];
  if (hints.returning) lines.push("sorry, got pulled into something yesterday");

  if (TURNED_AWAY.test(bot)) {
    const pushBack = "Are you sure? It's really not that far.";
    if (personaId === "out_of_area" && !has(pushBack)) return [...lines, pushBack].join("\n");
    return [...lines, "Ok, thanks anyway.", END("turned_away")].join("\n");
  }

  // People in a hurry answer everything at once.
  if (personaId === "emergency" && /\bphone\b|\baddress\b|\bname\b|reach you/i.test(bot)) {
    const details = `${truth.name}, ${truth.phone}, ${truth.street}`;
    if (!has(details)) return [...lines, details].join("\n");
  }

  const limit = personaId === "one_word" ? 1 : 2;
  const asked = TOPICS.filter(([, pattern]) => pattern.test(bot)).map(([topic]) => topic);
  let photo = false;
  for (const topic of asked) {
    if (lines.length >= limit + (hints.returning ? 1 : 0)) break;
    if (topic === "photo") {
      if (truth.photo !== null && !hints.photoSent && !photo) {
        photo = true;
        lines.push("Here's a photo.");
      }
      continue;
    }
    if (personaId === "tire_kicker" && (topic === "name" || topic === "phone")) {
      return [...lines, "I'll reach out when I'm ready. Thanks!", END("nothing_more")].join("\n");
    }
    if (personaId === "price_shopper" && topic === "phone") {
      const notYet = "I'd rather not get calls yet.";
      if (!has(notYet)) {
        lines.push(notYet);
        continue;
      }
    }
    const answer = answerFor(topic, hints);
    if (answer !== null && !has(answer)) lines.push(answer);
  }
  if (photo) lines.push("[photo]");
  if (lines.length > (hints.returning ? 1 : 0)) return lines.join("\n");

  // Nothing was asked that has not been answered: the customer's own questions, then goodbye.
  const probe = hints.probes.find((line) => !has(line));
  if (probe !== undefined) return [...lines, probe].join("\n");
  if (WRAPPED_UP.test(bot) || /anything else/i.test(bot)) {
    return [
      ...lines,
      personaId === "one_word" ? "no" : "No, that's all. Thank you!",
      END("satisfied"),
    ].join("\n");
  }
  return [...lines, personaId === "one_word" ? "ok" : "Ok, thanks.", END("nothing_more")].join(
    "\n",
  );
}

function isHints(value: unknown): value is CustomerHints {
  return (
    value !== null &&
    typeof value === "object" &&
    "personaId" in value &&
    "truth" in value &&
    "botTexts" in value
  );
}

/** The stand-in as a model client: answers a simulator request from its hints. */
export function createStandInCustomerModel(): ModelClient {
  return {
    name: "stand-in-customer",
    async call(request: ModelRequest): Promise<ModelResponse> {
      const hints = (request.hints as { customer?: unknown } | undefined)?.customer;
      if (!isHints(hints)) {
        throw new Error("The stand-in customer only answers requests of the customer simulator.");
      }
      const text = standInMove(hints);
      const content: ModelContentBlock[] = [{ type: "text", text, citations: null }];
      return {
        id: null,
        model: STAND_IN_CUSTOMER_MODEL,
        content,
        stopReason: "end_turn",
        stopDetails: null,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        requestId: null,
        fellBack: false,
      };
    },
  };
}
