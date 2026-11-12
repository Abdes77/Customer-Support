import { z } from "zod";

import {
  END_DISPOSITIONS,
  type EngineAction,
  type EngineActionType,
  NOT_A_FIT_CATEGORIES,
} from "@repo/core";

import type { ModelTool } from "../model/types";

/**
 * The tools the reply model can call: one per `EngineAction`. Each has the JSON schema the
 * API enforces (`strict: true`: every object closed, every property required, no numeric or
 * length constraints, which strict mode does not support), the Zod schema that checks the
 * same input again with the constraints strict mode cannot express, and the mapping to the
 * action the pipeline executes.
 *
 * Names, descriptions and schemas are the first bytes of every request and therefore of the
 * prompt cache: they are the same for every business and change only with a prompt release.
 */

export interface EngineTool {
  readonly name: EngineActionType;
  readonly description: string;
  readonly inputSchema: ModelTool["input_schema"];
  /** Parses the model's input into the action. Throws a ZodError on invalid input. */
  toAction(input: unknown): EngineAction;
}

const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] } as const;

function object(
  properties: Record<string, unknown>,
): ModelTool["input_schema"] & { readonly additionalProperties: false } {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

const text = z.string().trim().min(1);

const AnalyzePhotos = z.object({
  attachment_ids: z.array(text).min(1).max(10),
  question: text,
});

const BookMeeting = z.object({ slot_id: text });

const EndConversation = z.object({
  reason: text,
  disposition: z.enum(END_DISPOSITIONS),
});

const EscalateEmergency = z.object({ emergency_class: text, summary: text });

const HandoffToHuman = z.object({ reason: text, urgency: z.enum(["normal", "high"]) });

const MarkNotAFit = z.object({ category: z.enum(NOT_A_FIT_CATEGORIES), reason: text });

const OfferTimes = z.object({
  preference: z.string().trim().nullable(),
  count: z.number().int().min(1).max(5),
});

const RequestPhoto = z.object({ subject: text });

const ScheduleFollowUp = z.object({
  // ISO 8601 duration with at least one component, for example "PT2H" or "P1DT12H".
  after: z
    .string()
    .trim()
    .regex(/^P(?=\d|T\d)(\d+W)?(\d+D)?(T(\d+H)?(\d+M)?(\d+S)?)?$/, "must be an ISO 8601 duration"),
  reason: text,
});

const UpdateLeadFields = z.object({
  fields: z
    .array(
      z.object({
        key: text,
        value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
        confidence: z.number().min(0).max(1),
        evidence: z.string().trim().nullable(),
      }),
    )
    .min(1)
    .max(40),
});

export const ENGINE_TOOLS: readonly EngineTool[] = [
  {
    name: "analyze_photos",
    description:
      "Look at photos the customer sent in this conversation and get a description of what they show. Use it when the turn context lists a photo that has not been analyzed yet and the business's photo rules allow analysis. Ask one specific question per call, for example \"Where is the water stain and roughly how large is it?\". The result is a description for you and for the lead report; what you may tell the customer about it is set by the business's photo rules, and a photo never lets you name a cause or a diagnosis.",
    inputSchema: object({
      attachment_ids: {
        type: "array",
        items: { type: "string" },
        description: "Ids of the photos to look at, from the turn context.",
      },
      question: { type: "string", description: "What to find out from the photos." },
    }),
    toAction(input) {
      const parsed = AnalyzePhotos.parse(input);
      return {
        type: "analyze_photos",
        attachmentIds: parsed.attachment_ids,
        question: parsed.question,
      };
    },
  },
  {
    name: "book_meeting",
    description:
      "Book the meeting time the customer chose. Call it only with a slot_id that an offer_times result returned in this conversation, and only after the customer clearly picked that time. The result says whether the booking succeeded: confirm a meeting to the customer only when it did, and follow the instruction in the result when it did not.",
    inputSchema: object({
      slot_id: { type: "string", description: "The id of the chosen slot, from offer_times." },
    }),
    toAction(input) {
      return { type: "book_meeting", slotId: BookMeeting.parse(input).slot_id };
    },
  },
  {
    name: "end_conversation",
    description:
      'Mark the conversation as finished. Use disposition "completed" when the conversation has reached its natural end: the customer has what they need and said goodbye, or you have given a final answer such as a polite no. Use "stop_replying" only for spam, or for abuse that continued after a warning, when the business\'s rules say to stop; the bot then stays silent in this conversation until a person reopens it. You can still write a last message in the same turn.',
    inputSchema: object({
      reason: { type: "string", description: "Why the conversation is over, in a few words." },
      disposition: { type: "string", enum: [...END_DISPOSITIONS] },
    }),
    toAction(input) {
      const parsed = EndConversation.parse(input);
      return { type: "end_conversation", reason: parsed.reason, disposition: parsed.disposition };
    },
  },
  {
    name: "escalate_emergency",
    description:
      "Alert the business's on-call contacts about an emergency. Call it as soon as a message describes one of the business's emergency classes, judged by what the customer means and not by keywords, and before you ask anything else. Pass the class key from the business's emergency list and a one-sentence summary of what the customer reported. Call it once per emergency, not again for every message about it. The result tells you what you can say about the business's response; the safety instructions of the class always come first in your reply.",
    inputSchema: object({
      emergency_class: {
        type: "string",
        description: "The key of the emergency class, exactly as listed for this business.",
      },
      summary: {
        type: "string",
        description: "One sentence for the person being alerted: what is happening and where.",
      },
    }),
    toAction(input) {
      const parsed = EscalateEmergency.parse(input);
      return {
        type: "escalate_emergency",
        emergencyClass: parsed.emergency_class,
        summary: parsed.summary,
      };
    },
  },
  {
    name: "handoff_to_human",
    description:
      'Pass the conversation to a person at the business. Use it in the situations the business\'s handoff rules name, such as a customer who asks for a person, stays angry, complains about earlier work, disputes a charge or mentions a lawyer, or when you cannot make progress. After the handoff people take over, so the message you write in this turn is your last: say what happens next as the handoff rules describe. Use urgency "high" only for something that cannot wait until the next business day.',
    inputSchema: object({
      reason: {
        type: "string",
        description: "Why a person is needed, for the person who picks it up.",
      },
      urgency: { type: "string", enum: ["normal", "high"] },
    }),
    toAction(input) {
      const parsed = HandoffToHuman.parse(input);
      return { type: "handoff_to_human", reason: parsed.reason, urgency: parsed.urgency };
    },
  },
  {
    name: "mark_not_a_fit",
    description:
      "Record that this contact is not a potential customer of the business: spam or a scam, a sales pitch, someone looking for work, a wrong number, or a request the business clearly cannot take (a service it does not offer, a job outside its service area). For a real customer whose job may not fit, record what you learned with update_lead_fields first: the routing decision in that result usually settles it, and you call this only when it has not. The result tells you how to close the conversation.",
    inputSchema: object({
      category: { type: "string", enum: [...NOT_A_FIT_CATEGORIES] },
      reason: { type: "string", description: "One sentence for the lead report." },
    }),
    toAction(input) {
      const parsed = MarkNotAFit.parse(input);
      return { type: "mark_not_a_fit", reason: parsed.reason, category: parsed.category };
    },
  },
  {
    name: "offer_times",
    description:
      "Get concrete meeting times from the business's calendar to offer to the customer. Use it when the routing decision for this lead is to book a meeting and you have the details the business requires before booking. Pass the customer's preference in their own words when they stated one, for example \"weekday mornings\", otherwise null. Offer only times that the result returns. When the result is rejected or has no times, follow the instruction in the result instead of promising a time.",
    inputSchema: object({
      preference: {
        ...nullableString,
        description: "The customer's stated preference, or null.",
      },
      count: { type: "integer", description: "How many times to get, from 1 to 5." },
    }),
    toAction(input) {
      const parsed = OfferTimes.parse(input);
      return {
        type: "offer_times",
        preference:
          parsed.preference === null || parsed.preference.length === 0 ? null : parsed.preference,
        count: parsed.count,
      };
    },
  },
  {
    name: "request_photo",
    description:
      'Check whether you may ask the customer for a photo, and record that you are asking. Call it before you ask. subject says what to photograph, for example "the stained area of the ceiling from a few steps back". When the result is rejected, do not ask for a photo and carry on without one. When it is accepted, ask in your reply and include the safety reminder from the result.',
    inputSchema: object({
      subject: { type: "string", description: "What the customer should photograph." },
    }),
    toAction(input) {
      return { type: "request_photo", subject: RequestPhoto.parse(input).subject };
    },
  },
  {
    name: "schedule_follow_up",
    description:
      "Schedule a check-in with the customer after a wait, for when the customer said they need time (to talk to a spouse, to check a date, to get home and look) and named or implied when. after is an ISO 8601 duration counted from now, such as PT2H or P1D. Do not use it for the routine nudges to customers who simply go quiet: those are scheduled without you.",
    inputSchema: object({
      after: { type: "string", description: "ISO 8601 duration from now, for example PT4H." },
      reason: { type: "string", description: "What to pick up on when the time comes." },
    }),
    toAction(input) {
      const parsed = ScheduleFollowUp.parse(input);
      return { type: "schedule_follow_up", after: parsed.after, reason: parsed.reason };
    },
  },
  {
    name: "update_lead_fields",
    description:
      "Save what you learned about the customer and the job to the lead record. Call it in the same turn in which a message tells you something that belongs to one of the lead fields listed for this business, before you write your reply, with every field you learned in one call. For each field give the key from the list, the value in the form the list asks for, your confidence (1 when the customer stated it outright, lower when you inferred it) and a short quote or paraphrase as evidence. Use null as the value when the customer was asked and would not or could not say. The result carries the routing decision for this lead; your reply follows it.",
    inputSchema: object({
      fields: {
        type: "array",
        items: object({
          key: { type: "string", description: "A lead field key listed for this business." },
          value: {
            anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }],
            description: "The value, in the form the field asks for.",
          },
          confidence: { type: "number", description: "From 0 (a guess) to 1 (stated outright)." },
          evidence: {
            ...nullableString,
            description: "A short quote or paraphrase from the conversation, or null.",
          },
        }),
      },
    }),
    toAction(input) {
      const parsed = UpdateLeadFields.parse(input);
      return {
        type: "update_lead_fields",
        fields: parsed.fields.map((field) => ({
          key: field.key,
          value: field.value,
          confidence: field.confidence,
          evidence: field.evidence === null || field.evidence.length === 0 ? null : field.evidence,
        })),
      };
    },
  },
];

const BY_NAME: ReadonlyMap<string, EngineTool> = new Map(
  ENGINE_TOOLS.map((tool) => [tool.name, tool]),
);

export function findEngineTool(name: string): EngineTool | undefined {
  return BY_NAME.get(name);
}

/**
 * The tool list as it is sent: sorted by name, so the request starts with the same bytes
 * every time. `strict` is off only for organizations where structured outputs are not
 * available (customer-managed encryption keys); the Zod check covers both cases.
 */
export function modelTools(options: { readonly strict: boolean }): ModelTool[] {
  return [...ENGINE_TOOLS]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
      ...(options.strict ? { strict: true } : {}),
    }));
}
