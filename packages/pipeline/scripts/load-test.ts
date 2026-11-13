/**
 * The load test (C18): 50 businesses receiving bursts of customer messages at once, through
 * the real pipeline on local PostgreSQL with the in-process job runner and the offline model.
 * See `src/load/load-test.ts` for what it checks and what its numbers do and do not mean.
 *
 *   pnpm load:test                       # 50 businesses, 3 conversations each, 2 bursts of 3
 *   pnpm load:test --businesses 10 --conversations 2 --bursts 3 --burst-size 4
 *   pnpm load:test --no-cap              # without the business-at-its-daily-cap scenario
 *
 * It needs local PostgreSQL (`pnpm services:up`) and runs in a throwaway database it creates
 * and drops; it refuses to run when the test database server is not this machine, in a
 * production build or on a deployment. Exit code 1 when a check fails.
 */
import path from "node:path";
import { parseArgs } from "node:util";

import { loadTestRefusal } from "../src/load/guard";
import { DEFAULT_LOAD_TEST_OPTIONS, type Distribution, runLoadTest } from "../src/load/load-test";

for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(path.resolve(import.meta.dirname, "../../..", file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

const show = (d: Distribution) =>
  `p50 ${(d.p50 / 1000).toFixed(2)} s, p95 ${(d.p95 / 1000).toFixed(2)} s, max ${(d.max / 1000).toFixed(2)} s (${d.count})`;

async function main(): Promise<void> {
  // The guard needs the platform's own variables (NODE_ENV, VERCEL_ENV) next to the
  // database URLs, which the env spec does not declare.
  const refusal = loadTestRefusal(process.env);
  if (refusal !== null) {
    console.error(`The load test will not run: ${refusal}`);
    process.exitCode = 2;
    return;
  }
  const { values } = parseArgs({
    options: {
      businesses: { type: "string" },
      conversations: { type: "string" },
      bursts: { type: "string" },
      "burst-size": { type: "string" },
      "gap-ms": { type: "string" },
      "max-overhead-s": { type: "string" },
      "no-cap": { type: "boolean", default: false },
    },
  });
  const number = (value: string | undefined, fallback: number) => {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Not a whole number: ${value}`);
    return parsed;
  };
  const d = DEFAULT_LOAD_TEST_OPTIONS;
  const report = await runLoadTest({
    businesses: number(values.businesses, d.businesses),
    conversationsPerBusiness: number(values.conversations, d.conversationsPerBusiness),
    bursts: number(values.bursts, d.bursts),
    messagesPerBurst: number(values["burst-size"], d.messagesPerBurst),
    messageGapMs: number(values["gap-ms"], d.messageGapMs),
    maxOverheadMs: number(values["max-overhead-s"], d.maxOverheadMs / 1000) * 1000,
    cappedBusiness: !values["no-cap"],
    log: (line) => console.log(line),
  });

  console.log("");
  console.log("Load test (this machine, local PostgreSQL, in-process jobs, offline model)");
  console.log(`  businesses               ${report.businesses}`);
  console.log(`  conversations            ${report.conversations}`);
  console.log(`  customer messages        ${report.inboundMessages}`);
  console.log(`  bursts answered          ${report.bursts}`);
  console.log(`  reply turns              ${report.replyTurns}`);
  console.log(`  replies sent             ${report.outboundMessages}`);
  console.log(`  webhook handling         ${show(report.webhookMs)}`);
  console.log(
    `  reply latency            ${show(report.replyLatencyMs)} (configured wait ${(report.configuredWaitMs / 1000).toFixed(1)} s)`,
  );
  console.log(`  latency beyond the wait  ${show(report.overheadMs)}`);
  if (report.capped !== null) {
    console.log(
      `  business at its cap      ${report.capped.answeredBeforeCap} answered, ${report.capped.stoppedConversations} stopped, notices per stopped conversation [${report.capped.noticesPerStoppedConversation.join(", ")}], emergency ${report.capped.emergencyAnswered ? "answered" : "NOT answered"}`,
    );
  }
  console.log(`  duration                 ${(report.durationMs / 1000).toFixed(0)} s`);
  console.log("");
  if (report.failures.length === 0) {
    console.log("PASS: debounce, ordering, reply latency and limits held.");
  } else {
    console.log(`FAIL (${report.failures.length}):`);
    for (const failure of report.failures.slice(0, 30)) console.log(`  - ${failure}`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
