import { getServerPipeline } from "@/server/pipeline";

/**
 * Says so when the replies on this server do not come from Claude: a developer machine
 * without `ANTHROPIC_API_KEY` answers with the built-in rule-based stand-in, which shows how
 * the chat, the panel and the report work but not how the assistant writes. Nothing is shown
 * where the Claude API answers.
 */
export function ModelNotice() {
  let mode: string;
  try {
    mode = getServerPipeline().modelMode;
  } catch {
    return null;
  }
  if (mode === "live") return null;
  return (
    <p
      className="bg-amber-100 px-4 py-2 text-center text-sm text-amber-950"
      role="status"
      data-testid="demo-model-notice"
    >
      {mode === "offline"
        ? "This server has no Claude API key: the replies come from a simple built-in stand-in. It shows how the demo works, not how the assistant really writes."
        : "No Claude API key is configured on this server, so the assistant cannot answer yet."}
    </p>
  );
}
