import { z } from "zod";

/**
 * Website chat widget protocol (owner: C8): what the embeddable script
 * (`@repo/widget-embed`) and the public API under `/api/widget/v1` send each other.
 *
 * The server validates every request with these schemas. The browser script imports the
 * types only, so none of Zod ends up in the bundle a business's website loads.
 *
 * Nothing here may ever carry a secret, a staff-only field (scores, reports, notes, internal
 * ids beyond the visitor's own messages) or another visitor's data. The one deliberate
 * exception is `WidgetDemoLead`: the lead of the visitor's own conversation, served only for
 * a business that switched its public demo page on (`channels.widget.demo_page`).
 */

/** Public key of a business's widget: names the business and grants nothing else. */
export const WIDGET_PUBLIC_KEY_PATTERN = /^wpk_[A-Za-z0-9]{24}$/;
export const WidgetPublicKey = z.string().regex(WIDGET_PUBLIC_KEY_PATTERN);
export type WidgetPublicKey = z.infer<typeof WidgetPublicKey>;

/** Longest text a visitor can send in one message. */
export const WIDGET_MAX_TEXT_LENGTH = 4000;

/** A visitor-chosen id for one message, so a retried POST is stored once. */
export const WidgetClientMessageId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

export const WIDGET_PROFILE_FIELDS = ["name", "phone", "email"] as const;
export const WidgetProfileField = z.enum(WIDGET_PROFILE_FIELDS);
export type WidgetProfileField = z.infer<typeof WidgetProfileField>;

/** Image types a visitor may upload. Checked against the file's bytes, not its name. */
export const WIDGET_PHOTO_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
] as const;

export interface WidgetConfig {
  readonly key: string;
  readonly businessName: string;
  readonly botName: string;
  readonly appearance: {
    readonly primaryColor: string;
    readonly textColor: string;
    readonly logoUrl: string | null;
    readonly title: string;
    readonly subtitle: string;
    readonly teaser: string;
    readonly position: "bottom_right" | "bottom_left";
    /** Open by itself after this many seconds, once per visitor, never on phones. */
    readonly autoOpenSeconds: number | null;
  };
  /** Shown by the widget as the first bot bubble, before the visitor writes. */
  readonly greeting: string;
  /** Details the visitor fills in before the first message. */
  readonly preChat: readonly WidgetProfileField[];
  readonly photos: { readonly enabled: boolean; readonly maxBytes: number };
  readonly privacy: { readonly text: string; readonly url: string | null };
  /** `notice` is set when the office is closed and the business wants visitors to know. */
  readonly hours: { readonly open: boolean; readonly notice: string | null };
  readonly maxTextLength: number;
}

export const WidgetSessionRequest = z.object({
  key: WidgetPublicKey,
  /** The token of an earlier session on this site, to resume it. */
  token: z.string().min(1).max(2000).nullable(),
});
export type WidgetSessionRequest = z.infer<typeof WidgetSessionRequest>;

export interface WidgetRealtime {
  /** Supabase project URL; the script connects to its Realtime websocket. */
  readonly url: string;
  /** The project's publishable (anon) key. Public by design. */
  readonly apiKey: string;
  /** Broadcast topic of this visitor. It carries pokes only ("something changed"). */
  readonly topic: string;
}

export interface WidgetSession {
  readonly token: string;
  readonly expiresAt: string;
  /** Pre-chat details still missing before the visitor may write. */
  readonly needsProfile: readonly WidgetProfileField[];
  readonly realtime: WidgetRealtime | null;
  /** True when this session continues an earlier one (its history is worth loading). */
  readonly resumed: boolean;
}

export const WidgetProfileRequest = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  phone: z.string().trim().min(7).max(25).optional(),
  email: z.string().trim().max(254).optional(),
});
export type WidgetProfileRequest = z.infer<typeof WidgetProfileRequest>;

export interface WidgetProfileResult {
  readonly needsProfile: readonly WidgetProfileField[];
}

/** JSON body of a text message. A photo is sent as multipart form data with the same fields. */
export const WidgetMessageRequest = z.object({
  id: WidgetClientMessageId,
  text: z.string().max(WIDGET_MAX_TEXT_LENGTH).nullable().optional(),
});
export type WidgetMessageRequest = z.infer<typeof WidgetMessageRequest>;

export interface WidgetPostResult {
  readonly accepted: true;
  readonly duplicate: boolean;
}

export interface WidgetMessage {
  readonly id: string;
  /** The id the visitor's script chose, on the visitor's own messages. */
  readonly clientId: string | null;
  readonly from: "visitor" | "bot" | "team";
  readonly text: string | null;
  readonly at: string;
  /** Short-lived links to the photos of this message. */
  readonly photos: readonly { readonly url: string; readonly name: string | null }[];
  readonly quickReplies: readonly string[];
}

export interface WidgetMessages {
  readonly messages: readonly WidgetMessage[];
  /** Pass back as `after` to get only what is new. */
  readonly cursor: string;
  /** True while a reply is being written. */
  readonly typing: boolean;
}

/**
 * What the public demo page shows next to the chat: the lead the assistant is building from
 * the visitor's own conversation, as the business would see it in its inbox. Only ever served
 * for a business whose `channels.widget.demo_page` setting is on, and only for the session
 * that asks.
 */
export interface WidgetDemoLead {
  /** False until the visitor's first message has been answered and scored. */
  readonly started: boolean;
  /** 0 to 100. */
  readonly score: number | null;
  readonly band: string | null;
  readonly status: string | null;
  /** What the business's routing settings decided: book, call back, disqualify... */
  readonly routingOutcome: string | null;
  readonly routingReasons: readonly string[];
  /** What the assistant has learned so far, in the order of the business's criteria. */
  readonly fields: readonly WidgetDemoLeadField[];
  /** Criteria the assistant is still working toward. */
  readonly open: readonly string[];
  readonly report: { readonly summary: string; readonly markdown: string } | null;
  readonly updatedAt: string | null;
}

export interface WidgetDemoLeadField {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  /** 0 = a guess, 1 = stated outright by the customer. */
  readonly confidence: number;
  /** The customer's words the value rests on. */
  readonly evidence: string | null;
}

export const WIDGET_ERROR_CODES = [
  "invalid_request",
  "origin_not_allowed",
  "widget_not_found",
  "session_invalid",
  "profile_required",
  "rate_limited",
  "photos_disabled",
  "photo_too_large",
  "photo_type",
  "too_large",
  "unavailable",
] as const;
export type WidgetErrorCode = (typeof WIDGET_ERROR_CODES)[number];

export interface WidgetError {
  readonly error: WidgetErrorCode;
  readonly message: string;
  readonly retryAfterSeconds?: number;
}
