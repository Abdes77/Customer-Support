import { REPLY_V1_CANARY, REPLY_V1_TEXT } from "./reply-v1";

/**
 * The versions of the core system prompt. A version, once released, keeps its text; the
 * engine uses `CURRENT_REPLY_PROMPT`, and a conversation that started under an older
 * version simply continues under the new one (history is replayed as plain text, so no
 * thinking block is bound to the old prompt).
 */
export interface CorePrompt {
  readonly version: string;
  readonly text: string;
  /** A marker inside `text` that must never appear in a reply. */
  readonly canary: string;
}

export const REPLY_PROMPTS = {
  "reply-v1": { version: "reply-v1", text: REPLY_V1_TEXT, canary: REPLY_V1_CANARY },
} as const satisfies Record<string, CorePrompt>;

export const CURRENT_REPLY_PROMPT: CorePrompt = REPLY_PROMPTS["reply-v1"];

/**
 * Version of everything the engine renders from code around the core prompt: the playbook
 * and business sections, the history, the turn context, the tool results. Raise it whenever
 * that rendering changes (the fingerprint test in `render.test.ts` says when).
 */
export const RENDER_VERSION = 3;

/** What a turn and its model calls record as their prompt version, for example "reply-v1.r1". */
export const PROMPT_VERSION = `${CURRENT_REPLY_PROMPT.version}.r${RENDER_VERSION}`;
