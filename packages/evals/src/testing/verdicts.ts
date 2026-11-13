import type { ModelClient, ModelResponse } from "@repo/ai";

import { CRITERIA, type Criterion, JUDGE_TOOL_NAME } from "../grade/rubric";
import { RULE_IDS, type RuleId } from "../grade/rules";

/**
 * Hand-written verdicts in the judge tool's input format, for tests that need a judge that
 * says something specific.
 */

export interface VerdictSpec {
  /** Scores by criterion; the rest get `base`. */
  readonly scores?: Partial<Record<Criterion, number | null>>;
  /** Default 5. */
  readonly base?: number;
  readonly violations?: readonly {
    readonly rule: RuleId;
    readonly quote: string | null;
    readonly evidence?: "quote" | "omission";
    readonly explanation?: string;
  }[];
  readonly claims?: readonly {
    readonly kind: string;
    readonly quote: string;
    readonly explanation?: string;
  }[];
  readonly summary?: string;
}

export function verdictInput(spec: VerdictSpec = {}): Record<string, unknown> {
  const base = spec.base ?? 5;
  return {
    criteria: Object.fromEntries(
      CRITERIA.map((criterion) => {
        const given = spec.scores?.[criterion];
        return [
          criterion,
          { score: given === undefined ? base : given, reason: `Reason for ${criterion}.` },
        ];
      }),
    ),
    rule_verdicts: RULE_IDS.map((rule) => {
      const violation = spec.violations?.find((item) => item.rule === rule);
      return violation === undefined
        ? { rule, verdict: "complied", evidence: "none", quote: null, explanation: "Followed." }
        : {
            rule,
            verdict: "violated",
            evidence: violation.evidence ?? (violation.quote === null ? "omission" : "quote"),
            quote: violation.quote,
            explanation: violation.explanation ?? `The ${rule} rule was not followed.`,
          };
    }),
    unsupported_claims: (spec.claims ?? []).map((claim) => ({
      kind: claim.kind,
      quote: claim.quote,
      explanation: claim.explanation ?? "Nothing the bot was given supports this.",
    })),
    summary: spec.summary ?? "A good conversation.",
  };
}

let calls = 0;

/** A response of the judge model that submits `input` through the tool. */
export function verdictResponse(input: unknown, model = "claude-opus-5-5"): ModelResponse {
  calls += 1;
  return {
    id: `msg_judge_${calls}`,
    model,
    content: [{ type: "tool_use", id: `toolu_judge_${calls}`, name: JUDGE_TOOL_NAME, input }],
    stopReason: "tool_use",
    stopDetails: null,
    usage: {
      inputTokens: 5000,
      outputTokens: 800,
      cacheReadInputTokens: 2000,
      cacheCreationInputTokens: 0,
    },
    requestId: "req_judge",
    fellBack: false,
  };
}

/**
 * A judge model for tests: answers every request with the verdict `decide` returns for it
 * (the request's first user message is the conversation's context).
 */
export function fakeJudgeModel(
  decide: (context: string, call: number) => VerdictSpec = () => ({}),
  model = "claude-opus-5-5",
): ModelClient & { readonly contexts: string[] } {
  const contexts: string[] = [];
  return {
    name: "fake-judge",
    contexts,
    async call(request) {
      const first = request.messages[0]?.content;
      const context = typeof first === "string" ? first : JSON.stringify(first);
      contexts.push(context);
      return verdictResponse(verdictInput(decide(context, contexts.length)), model);
    },
  };
}
