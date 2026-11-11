import type { ConversationEngine, EngineTurnResult, ReplyDraft } from "@repo/core";

export const ECHO_PROMPT_VERSION = "echo-stub-1";

/**
 * The stand-in conversation engine until C4 replaces it at the composition root. It answers
 * the pending customer messages by repeating them, so a round trip through the whole
 * pipeline is visible on the dev chat page and in tests. It calls no model and no tool.
 */
export function createEchoEngine(): ConversationEngine {
  return {
    async respond(input): Promise<EngineTurnResult> {
      const base = {
        actions: [],
        promptVersion: ECHO_PROMPT_VERSION,
        settingsVersion: input.settings.version,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      };
      if (input.pending.length === 0) return { ...base, outcome: "no_reply", replies: [] };

      const texts = input.pending
        .map((turn) => turn.text?.trim() ?? "")
        .filter((text) => text.length > 0);
      const files = input.pending.reduce((total, turn) => total + turn.attachments.length, 0);
      const lines: string[] = [];
      if (texts.length > 0) lines.push(`You said: ${texts.join(" / ")}`);
      if (files > 0) lines.push(`(${files} attachment${files === 1 ? "" : "s"} received)`);
      if (lines.length === 0) lines.push("I received your message.");
      const text = lines.join("\n");

      const draft: ReplyDraft =
        input.channel.capabilities.format === "email"
          ? { kind: "email", subject: null, text }
          : { kind: "text", text };
      return { ...base, outcome: "replied", replies: [draft] };
    },
  };
}
