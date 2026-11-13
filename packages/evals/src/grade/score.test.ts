import { describe, expect, it } from "vitest";

import {
  botSays,
  customerSays,
  properOpening,
  scenarioWith,
  transcriptOf,
} from "../testing/transcripts";
import { verdictInput } from "../testing/verdicts";
import { runChecks } from "./checks";
import { JudgeAnswer, type JudgeResult, settleAnswer } from "./judge";
import { DEFAULT_THRESHOLDS } from "./rubric";
import { gradeConversation } from "./score";
import { NO_USAGE } from "../simulate/transcript";

const scenario = scenarioWith({ persona: "ready_to_book", profile: "default" });
const good = transcriptOf(scenario, [
  customerSays(1, scenario.instance.opening),
  botSays(1, [`${properOpening(scenario)} Sorry about the leak. What's the ZIP code?`]),
]);
// The same conversation with a price in it, which the default profile forbids.
const priced = transcriptOf(scenario, [
  customerSays(1, scenario.instance.opening),
  botSays(1, [`${properOpening(scenario)} That is usually about $900. What's the ZIP code?`]),
]);

function judged(
  spec: Parameters<typeof verdictInput>[0],
  transcript = good,
  standIn = false,
): JudgeResult {
  return {
    model: standIn ? "stand-in-judge-1" : "claude-opus-5-5",
    requestedModel: "claude-opus-5-5",
    standIn,
    ...settleAnswer(JudgeAnswer.parse(verdictInput(spec)), transcript),
    usage: NO_USAGE,
    calls: [],
  };
}

const grade = (transcript: typeof good, judge: JudgeResult, mode: "live" | "mock" = "live") =>
  gradeConversation({
    mode,
    // Routing and field checks depend on a longer conversation; they are not what is tested here.
    checks: runChecks(scenario, transcript).filter(
      (check) => check.id !== "routing_expected" && check.id !== "fields_captured",
    ),
    judge,
    thresholds: DEFAULT_THRESHOLDS,
  });

describe("gradeConversation, live", () => {
  it("passes a conversation with good scores and no evidence against it", () => {
    const result = grade(good, judged({ scores: { engagement: 4, routing: null } }));
    expect(result).toMatchObject({ passed: true, failures: [], complianceFailures: 0 });
    // Six applicable criteria: five 5s and a 4.
    expect(result.overall).toBe(4.83);
    expect(result.scores.routing).toBeNull();
  });

  it("fails below the pass score", () => {
    const result = grade(
      good,
      judged({ base: 4, scores: { engagement: 3, qualification: 3, routing: 3 } }),
    );
    expect(result.overall).toBe(3.57);
    expect(result.passed).toBe(false);
    expect(result.failures.map((failure) => failure.kind)).toEqual(["score"]);
  });

  it("fails a criterion under its floor even when the average is fine", () => {
    const result = grade(good, judged({ scores: { safety: 3 } }));
    expect(result.overall).toBeGreaterThan(DEFAULT_THRESHOLDS.passScore);
    expect(result.failures).toEqual([
      expect.objectContaining({ kind: "floor", id: "safety", criterion: "safety" }),
    ]);
    // Engagement may be 3: its floor is lower than safety's.
    expect(grade(good, judged({ scores: { engagement: 3 } })).passed).toBe(true);
  });

  it("counts a failed check as a compliance failure and caps the criterion, whatever the judge said", () => {
    const result = grade(priced, judged({}, priced));
    expect(result.passed).toBe(false);
    expect(result.complianceFailures).toBe(1);
    expect(result.scores.setting_compliance).toBe(2);
    expect(result.failures).toEqual([
      expect.objectContaining({
        kind: "check",
        id: "prices_from_sources",
        criterion: "setting_compliance",
      }),
    ]);
    expect(result.failures[0]?.detail).toContain(
      "Found: reply 1: $900 while prices are never disclosed.",
    );
  });

  it("counts a rule violation the judge evidenced, and an invented claim", () => {
    const result = grade(
      priced,
      judged(
        {
          violations: [{ rule: "pricing", quote: "That is usually about $900." }],
          claims: [{ kind: "price", quote: "usually about $900" }],
        },
        priced,
      ),
    );
    expect(result.complianceFailures).toBe(2);
    expect(result.scores.accuracy).toBe(2);
    expect(result.failures.map((failure) => `${failure.kind}:${failure.id}`)).toEqual([
      "check:prices_from_sources",
      "rule:pricing",
      "claim:price",
    ]);
  });

  it("does not count a finding whose quote is not in the conversation", () => {
    const result = grade(
      good,
      judged({ violations: [{ rule: "voice", quote: "Yo dude what up" }] }),
    );
    expect(result).toMatchObject({ passed: true, complianceFailures: 0 });
  });
});

describe("gradeConversation, mock", () => {
  it("has no scores, and only a rule the engine enforces in code can fail it", () => {
    const fine = grade(good, judged({}, good, true), "mock");
    expect(fine).toMatchObject({ mode: "mock", passed: true, overall: null });
    expect(Object.values(fine.scores).every((score) => score === null)).toBe(true);

    const broken = grade(priced, judged({}, priced, true), "mock");
    expect(broken.passed).toBe(false);
    expect(broken.failures.map((failure) => failure.id)).toEqual(["prices_from_sources"]);
  });

  it("ignores behaviour that depends on the model: a stand-in is not the bot", () => {
    const angry = scenarioWith({ persona: "angry_past_job" });
    const transcript = transcriptOf(angry, [
      customerSays(1, angry.instance.opening),
      botSays(1, [`${properOpening(angry)} What's the ZIP code?`]),
    ]);
    const checks = runChecks(angry, transcript);
    expect(checks.find((check) => check.id === "handoff_as_expected")?.passed).toBe(false);
    const mock = gradeConversation({
      mode: "mock",
      checks,
      judge: judged({}, transcript, true),
      thresholds: DEFAULT_THRESHOLDS,
    });
    expect(mock.passed).toBe(true);
    const live = gradeConversation({
      mode: "live",
      checks,
      judge: judged({}, transcript),
      thresholds: DEFAULT_THRESHOLDS,
    });
    expect(live.failures.map((failure) => failure.id)).toContain("handoff_as_expected");
  });

  it("never grades a live run with a stand-in's placeholder verdict: no score is not a pass", () => {
    expect(() => grade(good, judged({ base: 5 }, good, true), "live")).toThrow(
      "cannot be graded by the stand-in judge",
    );
  });
});
