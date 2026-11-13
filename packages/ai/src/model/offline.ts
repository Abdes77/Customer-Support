import type { ReplyHints } from "../engine/hints";
import type {
  ModelClient,
  ModelContentBlock,
  ModelMessageParam,
  ModelRequest,
  ModelResponse,
} from "./types";

/**
 * A stand-in for the model that needs no API key: it answers reply requests by simple rules
 * from the structured hints the engine attaches to each request. It exists so the product
 * can be run and tested end to end on a developer machine and in CI: the dev chat answers,
 * leads get fields, later chunks' browser tests have a bot to talk to.
 *
 * It is not a language model and is never used on a hosted deployment (see
 * `createModelClientFromEnv`). Its replies are deliberately plain.
 */

export const OFFLINE_MODEL_ID = "offline-rules-1";

const QUESTIONS: Readonly<Record<string, string>> = {
  service_type: "What can we help you with?",
  job_scope: "Can you tell me a bit more about what's going on?",
  service_area: "What's the ZIP code of the property?",
  timeline: "How soon are you hoping to have this done?",
  decision_maker: "Do you own the home?",
  budget: "Do you have a budget in mind?",
  property_type: "What kind of property is it?",
  contact_name: "What's your name?",
  contact_phone: "What's the best phone number to reach you?",
  contact_email: "What's your email address?",
  job_address: "What's the address of the property?",
};

const TIMELINES: readonly (readonly [RegExp, string])[] = [
  [/\b(right now|emergency|immediately|tonight)\b/i, "emergency"],
  [/\b(asap|as soon as possible|today|tomorrow|this week|few days)\b/i, "this_week"],
  [/\b(next week|this month|couple of weeks|two weeks|2 weeks)\b/i, "this_month"],
  [
    /\b(next month|few months|couple of months|this spring|this summer|this fall)\b/i,
    "one_to_three_months",
  ],
  [/\b(next year|no rush|someday|eventually)\b/i, "later"],
  [/\b(just (looking|researching|curious)|getting ideas)\b/i, "just_researching"],
];

const ROLES: readonly (readonly [RegExp, string])[] = [
  [/\b(property manager|i manage)\b/i, "property_manager"],
  [/\b(landlord|my rental|i rent it out)\b/i, "landlord"],
  [/\b(i rent|we rent|renting|tenant)\b/i, "tenant"],
  [/\b(i own|we own|homeowner|my house|my home|our house|our home|yes.{0,12}own)\b/i, "homeowner"],
];

const PROPERTIES: readonly (readonly [RegExp, string])[] = [
  [/\b(condo|apartment)\b/i, "condo"],
  [/\b(townhouse|townhome)\b/i, "townhouse"],
  [/\b(duplex|triplex|multi-family)\b/i, "multi_family"],
  [/\b(office|store|restaurant|commercial|warehouse)\b/i, "commercial"],
  [/\b(house|single family|single-family)\b/i, "single_family"],
];

interface Field {
  key: string;
  value: string | number | boolean | null;
  confidence: number;
  evidence: string | null;
}

function firstMatch(text: string, table: readonly (readonly [RegExp, string])[]): string | null {
  for (const [pattern, value] of table) if (pattern.test(text)) return value;
  return null;
}

function extract(hints: ReplyHints): Field[] {
  const text = hints.customerText;
  const open = new Set(hints.open.map((field) => field.key));
  const fields: Field[] = [];
  const add = (key: string, value: Field["value"], confidence = 0.9) => {
    if (open.has(key) && value !== null) {
      fields.push({ key, value, confidence, evidence: text.slice(0, 120) });
    }
  };
  add("service_area", /\b\d{5}\b/.exec(text)?.[0] ?? null);
  add("timeline", firstMatch(text, TIMELINES));
  add("decision_maker", firstMatch(text, ROLES));
  add("property_type", firstMatch(text, PROPERTIES), 0.7);
  add(
    "contact_name",
    /\b(?:my name is|i'm|i am|this is)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/.exec(text)?.[1] ?? null,
  );
  add(
    "contact_phone",
    /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/.exec(text)?.[0] ?? null,
  );
  add("contact_email", /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(text)?.[0] ?? null);
  add(
    "job_address",
    /\b\d{1,6}\s+[A-Za-z][\w .]*\b(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|way|court|ct)\b\.?/i.exec(
      text,
    )?.[0] ?? null,
  );
  // The first thing a customer writes is nearly always what they need.
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words >= 3 && fields.length <= 1) {
    const summary =
      text
        .trim()
        .split(/(?<=[.!?])\s/)[0]
        ?.slice(0, 160) ?? "";
    add("service_type", summary, 0.6);
    add("job_scope", text.trim().slice(0, 300), 0.6);
  }
  return fields;
}

function isToolResultMessage(message: ModelMessageParam | undefined): boolean {
  return (
    message?.role === "user" &&
    Array.isArray(message.content) &&
    message.content.some((block) => block.type === "tool_result")
  );
}

/** The messages of the current turn: everything after the last plain customer turn. */
function thisTurn(messages: readonly ModelMessageParam[]): ModelMessageParam[] {
  let start = messages.length;
  while (start > 0) {
    const message = messages[start - 1];
    if (message?.role === "user" && !isToolResultMessage(message)) break;
    start -= 1;
  }
  return messages.slice(start);
}

function toolNamesUsed(turn: readonly ModelMessageParam[]): {
  names: Set<string>;
  saved: Set<string>;
} {
  const names = new Set<string>();
  const saved = new Set<string>();
  for (const message of turn) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      names.add(block.name);
      const input = block.input as { fields?: { key?: unknown }[] } | null;
      for (const field of input?.fields ?? []) {
        if (typeof field.key === "string") saved.add(field.key);
      }
    }
  }
  return { names, saved };
}

function toolResultText(turn: readonly ModelMessageParam[]): string {
  const parts: string[] = [];
  for (const message of turn) {
    if (!isToolResultMessage(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_result" && typeof block.content === "string")
        parts.push(block.content);
    }
  }
  return parts.join("\n");
}

function replyText(hints: ReplyHints, routing: string | null, saved: ReadonlySet<string>): string {
  const business = hints.businessName;
  if (hints.emergency !== null) {
    return `${hints.emergency.instructions}\n\nI've let the team at ${business} know. What's the best phone number to reach you, and what's the address?`;
  }
  if (hints.emergencyOnly) return "<no_reply/>";
  if (hints.afterHours === "send_message") return "<after_hours_message/>";
  if (hints.afterHours === "stay_silent") return "<no_reply/>";
  if (routing === "disqualify") {
    return `Thanks for reaching out. I'm sorry, this isn't something ${business} can take on. I hope you find the right help soon.`;
  }
  const open = hints.open.filter((field) => !saved.has(field.key) && field.group !== "detail");
  if (routing === "contact_later" || routing === "book_meeting" || open.length === 0) {
    return `Thanks, that's what the team needs. Someone from ${business} will reach out ${hints.contactLaterTimeframe}. Is there anything else they should know first?`;
  }
  const questions = open
    .slice(0, Math.max(1, hints.questionsPerMessage))
    .map(
      (field) =>
        QUESTIONS[field.key] ?? `Could you tell me about this: ${field.label.toLowerCase()}?`,
    );
  const opener =
    hints.purpose === "nudge"
      ? "Just checking in on your project."
      : hints.firstReply
        ? `Thanks for reaching out to ${business}!`
        : "Thanks, got it.";
  return `${opener} ${questions.join(" ")}`;
}

function estimateTokens(request: ModelRequest): number {
  const characters =
    request.system.reduce((total, block) => total + block.text.length, 0) +
    JSON.stringify(request.messages).length;
  return Math.ceil(characters / 4);
}

export function createOfflineModelClient(): ModelClient {
  let calls = 0;
  const respond = (request: ModelRequest, content: ModelContentBlock[]): ModelResponse => ({
    id: null,
    model: OFFLINE_MODEL_ID,
    content,
    stopReason: content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
    stopDetails: null,
    usage: {
      inputTokens: estimateTokens(request),
      outputTokens: Math.ceil(JSON.stringify(content).length / 4),
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    requestId: null,
    fellBack: false,
  });
  const say = (value: string): ModelContentBlock => ({
    type: "text",
    text: value,
    citations: null,
  });
  const use = (name: string, input: unknown): ModelContentBlock => {
    calls += 1;
    return { type: "tool_use", id: `toolu_offline_${calls}`, name, input };
  };

  return {
    name: "offline",
    async call(request) {
      const hints = (request.hints as { reply?: ReplyHints } | undefined)?.reply;
      if (hints === undefined) {
        return respond(request, [
          say(
            request.purpose === "photo_analysis"
              ? "A photo was received. It was not analyzed: the offline model cannot look at pictures."
              : "No answer is available: the offline model only writes customer replies.",
          ),
        ]);
      }

      const turn = thisTurn(request.messages);
      const used = toolNamesUsed(turn);
      const toolsAllowed = request.toolChoice !== "none" && (request.tools?.length ?? 0) > 0;

      if (toolsAllowed && used.names.size === 0) {
        const tools: ModelContentBlock[] = [];
        if (hints.emergency !== null) {
          tools.push(
            use("escalate_emergency", {
              emergency_class: hints.emergency.key,
              summary: `Customer reported: ${hints.customerText.slice(0, 160)}`,
            }),
          );
        }
        const fields = extract(hints);
        if (fields.length > 0) tools.push(use("update_lead_fields", { fields }));
        if (hints.photoAnalysis && hints.unanalyzedPhotos.length > 0) {
          tools.push(
            use("analyze_photos", {
              attachment_ids: [...hints.unanalyzedPhotos],
              question: "What does the photo show?",
            }),
          );
        }
        if (tools.length > 0) return respond(request, tools);
      }

      const routing =
        /Routing decision: (book_meeting|contact_later|disqualify)/.exec(
          toolResultText(turn),
        )?.[1] ?? hints.routing;
      const reply = replyText(hints, routing, used.saved);
      const limit = hints.maxCharacters;
      return respond(request, [
        say(reply.length > limit && !hints.email ? reply.slice(0, limit) : reply),
      ]);
    },
  };
}
