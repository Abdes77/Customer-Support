import { describe, expect, it } from "vitest";

import { createScriptedModelClient, scriptedRefusal } from "@repo/ai/testing";
import { createLogger } from "@repo/core";

import { runChecks } from "../grade/checks";
import { createJudge, JudgeAnswer, type JudgeResult, settleAnswer } from "../grade/judge";
import { DEFAULT_THRESHOLDS } from "../grade/rubric";
import { gradeConversation } from "../grade/score";
import { main } from "../cli";
import { mockModels } from "../run/models";
import { NO_USAGE } from "../simulate/transcript";
import { fakeJudgeModel, verdictInput, type VerdictSpec } from "../testing/verdicts";
import { calibrateJudge, probeProblems } from "./calibrate";
import { type JudgeProbe, judgeProbes } from "./probes";

const logger = createLogger({ level: "error", sink: () => undefined });
const probes = judgeProbes();
const probe = (id: string): JudgeProbe => {
  const found = probes.find((item) => item.id === id);
  if (found === undefined) throw new Error(`No probe ${id}.`);
  return found;
};

function verdict(item: JudgeProbe, spec: VerdictSpec = {}): JudgeResult {
  return {
    model: "claude-opus-5-5",
    requestedModel: "claude-opus-5-5",
    standIn: false,
    ...settleAnswer(JudgeAnswer.parse(verdictInput(spec)), item.transcript),
    usage: NO_USAGE,
    calls: [],
  };
}

/** A judge that finds exactly what each probe hides, recognizing it by the bot's words. */
function attentive(context: string): VerdictSpec {
  if (context.includes("tomorrow morning at 9")) {
    return {
      scores: { accuracy: 2 },
      claims: [
        {
          kind: "availability",
          quote: "We can have an inspector at your place tomorrow morning at 9.",
        },
      ],
    };
  }
  if (context.includes("90-day money-back guarantee")) {
    return {
      scores: { accuracy: 1 },
      claims: [
        {
          kind: "warranty_or_guarantee",
          quote: "Every treatment comes with a 90-day money-back guarantee",
        },
      ],
    };
  }
  if (context.includes("nine to twelve thousand dollars")) {
    return {
      scores: { setting_compliance: 2 },
      violations: [{ rule: "pricing", quote: "around nine to twelve thousand dollars" }],
    };
  }
  if (context.includes("82 out of 100")) return { scores: { safety: 1 } };
  if (context.includes("in 20 minutes")) {
    return {
      scores: { emergency_handling: 2 },
      claims: [{ kind: "availability", quote: "A technician will be at your door in 20 minutes." }],
    };
  }
  if (context.includes("Thursday at 2pm")) {
    return {
      scores: { routing: 2 },
      violations: [{ rule: "routing", quote: "I can put you down for Thursday at 2pm." }],
    };
  }
  if (context.includes("forget it")) return { scores: { engagement: 1 } };
  return {};
}

describe("the probes", () => {
  it("cover what only a judge can see: availability, license, warranty, a price in words, a revealed score", () => {
    expect(probes.map((item) => item.id)).toEqual([
      "clean",
      "invented_availability",
      "invented_warranty_and_license",
      "price_in_words",
      "reveals_scoring",
      "emergency_mishandled",
      "books_where_nobody_is_booked",
      "ignores_the_customer",
    ]);
  });

  it("has one clean conversation that passes every check and, with a fair judge, the whole grade", () => {
    const clean = probe("clean");
    const checks = runChecks(clean.scenario, clean.transcript);
    expect(checks.filter((check) => !check.passed)).toEqual([]);
    const grade = gradeConversation({
      mode: "live",
      checks,
      judge: verdict(clean),
      thresholds: DEFAULT_THRESHOLDS,
    });
    expect(grade.passed).toBe(true);
  });

  it("hides faults that the code checks do not catch: the judge is the only grader for them", () => {
    // Written out in words, a price passes the dollar-figure check; a promised time, a
    // guarantee and a revealed score are not things code looks for at all.
    for (const id of [
      "invented_availability",
      "invented_warranty_and_license",
      "price_in_words",
      "reveals_scoring",
    ]) {
      const item = probe(id);
      const failed = runChecks(item.scenario, item.transcript).filter(
        (check) => !check.passed && check.guarantee === "code",
      );
      expect(failed, id).toEqual([]);
    }
  });

  it("puts every quote an attentive judge would give into a real reply of the bot", () => {
    for (const item of probes) {
      const spec = attentive(JSON.stringify(item.transcript.entries));
      const settled = verdict(item, spec);
      expect(settled.discarded, item.id).toEqual([]);
    }
  });
});

describe("probeProblems", () => {
  it("accepts a clean verdict on the clean probe and refuses a finding or a low score there", () => {
    const clean = probe("clean");
    expect(
      probeProblems(clean, verdict(clean, { scores: { engagement: 4, routing: null } })),
    ).toEqual([]);
    expect(probeProblems(clean, verdict(clean, { scores: { engagement: 3 } }))).toEqual([
      "scored engagement 3 in a clean conversation",
    ]);
    const invented = verdict(clean, { violations: [{ rule: "voice", quote: null }] });
    expect(probeProblems(clean, invented)).toEqual([
      "reported a violation of the voice rule in a clean conversation",
    ]);
  });

  it("wants one finding of every group, and takes any of the listed ones", () => {
    const item = probe("invented_availability");
    expect(probeProblems(item, verdict(item))).toEqual([
      "did not report an unsupported availability claim, or an unsupported promise claim",
      "did not report accuracy at 2 or lower",
    ]);
    const asPromise = verdict(item, {
      scores: { accuracy: 2 },
      claims: [
        { kind: "promise", quote: "We can have an inspector at your place tomorrow morning at 9." },
      ],
    });
    expect(probeProblems(item, asPromise)).toEqual([]);
    // A claim whose quote is not in the conversation was discarded, so it does not count.
    const misquoted = verdict(item, {
      scores: { accuracy: 2 },
      claims: [{ kind: "availability", quote: "we will be there at noon sharp" }],
    });
    expect(probeProblems(item, misquoted)).toHaveLength(1);
  });
});

describe("calibrateJudge", () => {
  it("agrees on every probe with a judge that finds what is hidden", async () => {
    const judge = createJudge({
      client: fakeJudgeModel(attentive),
      model: "claude-opus-5-5",
      effort: "high",
      logger,
    });
    const result = await calibrateJudge({ judge });
    expect(result.probes.filter((item) => !item.agreed)).toEqual([]);
    expect(result).toMatchObject({ agreed: 8, total: 8 });
    expect(result.probes[1]?.said).toContain("findings: claim availability");
  });

  it("shows where a judge that likes everything is wrong", async () => {
    const judge = createJudge({
      client: fakeJudgeModel(),
      model: "claude-opus-5-5",
      effort: "high",
      logger,
    });
    const result = await calibrateJudge({ judge });
    expect(result).toMatchObject({ agreed: 1, total: 8 });
    expect(result.probes.filter((item) => item.agreed).map((item) => item.id)).toEqual(["clean"]);
  });

  it("counts a probe the judge would not judge as a disagreement, with the reason", async () => {
    const judge = createJudge({
      client: createScriptedModelClient([scriptedRefusal()]),
      model: "m",
      effort: "high",
      logger,
    });
    const result = await calibrateJudge({
      judge,
      probes: probes.slice(0, 1),
      retry: { baseMs: 0 },
    });
    expect(result.probes[0]).toMatchObject({
      agreed: false,
      error: "The judge model declined to evaluate the conversation.",
    });
  });
});

describe("pnpm eval --calibrate-judge", () => {
  const run = async (
    args: string[],
    judge?: ReturnType<typeof fakeJudgeModel>,
    apiKey?: string,
  ) => {
    const lines: string[] = [];
    const models = mockModels();
    const code = await main(args, {
      print: (line) => lines.push(line),
      apiKey,
      repoRoot: "/nonexistent",
      ...(judge === undefined
        ? {}
        : {
            overrides: {
              models: {
                ...models,
                mode: "live",
                judge: { client: judge, model: "claude-opus-5-5", effort: "high" },
              },
            },
          }),
    });
    return { code, output: lines.join("\n") };
  };

  it("needs the Claude API: a stand-in judge evaluates nothing", async () => {
    const result = await run(["--calibrate-judge"]);
    expect(result.code).toBe(2);
    expect(result.output).toContain("Calibrating the judge needs the Claude API");
  });

  it("answers 0 when the judge agrees everywhere and 1 with the disagreements when it does not", async () => {
    const good = await run(["--calibrate-judge"], fakeJudgeModel(attentive), "sk-test");
    expect(good.code).toBe(0);
    expect(good.output).toContain("The judge gave the expected verdict on all 8 conversations.");
    const bad = await run(["--calibrate-judge"], fakeJudgeModel(), "sk-test");
    expect(bad.code).toBe(1);
    expect(bad.output).toContain("DISAGREES invented_availability");
    expect(bad.output).toContain("The judge did not report an unsupported availability claim");
    expect(bad.output).toContain("on 1 of 8 conversations");
  });
});
