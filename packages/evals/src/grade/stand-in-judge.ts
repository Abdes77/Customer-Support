import type { ModelClient, ModelContentBlock, ModelRequest, ModelResponse } from "@repo/ai";

import { type JudgeHints, STAND_IN_JUDGE_MODEL } from "./judge";
import { JUDGE_TOOL_NAME } from "./rubric";
import { RULE_IDS } from "./rules";

/**
 * A stand-in for the judge model, for runs without an API key. It answers through the same
 * tool, so the whole judging path (request, tool call, validation, settling) runs; but it
 * evaluates nothing. A verdict that came from it is marked as such, its scores are never
 * shown or counted, and a run judged by it cannot become a baseline.
 */

export { STAND_IN_JUDGE_MODEL };

const NOTE = "Not judged: no judge model was run.";

function isHints(value: unknown): value is JudgeHints {
  return value !== null && typeof value === "object" && "emergency" in value && "spam" in value;
}

export function createStandInJudgeModel(): ModelClient {
  let calls = 0;
  return {
    name: "stand-in-judge",
    async call(request: ModelRequest): Promise<ModelResponse> {
      const hints = (request.hints as { judge?: unknown } | undefined)?.judge;
      if (!isHints(hints)) {
        throw new Error("The stand-in judge only answers requests of the evaluation judge.");
      }
      calls += 1;
      const placeholder = { score: 3, reason: NOTE };
      const content: ModelContentBlock[] = [
        {
          type: "tool_use",
          id: `toolu_standin_judge_${calls}`,
          name: JUDGE_TOOL_NAME,
          input: {
            criteria: {
              qualification:
                hints.spam || hints.emergency ? { score: null, reason: NOTE } : placeholder,
              accuracy: placeholder,
              setting_compliance: placeholder,
              engagement: placeholder,
              emergency_handling: placeholder,
              safety: placeholder,
              routing: hints.emergency ? { score: null, reason: NOTE } : placeholder,
            },
            rule_verdicts: RULE_IDS.map((rule) => ({
              rule,
              verdict: "not_applicable",
              evidence: "none",
              quote: null,
              explanation: NOTE,
            })),
            unsupported_claims: [],
            summary:
              "Placeholder verdict from the stand-in judge. No model evaluated this conversation.",
          },
        },
      ];
      return {
        id: null,
        model: STAND_IN_JUDGE_MODEL,
        content,
        stopReason: "tool_use",
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
