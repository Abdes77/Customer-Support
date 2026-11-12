/**
 * Live check of the conversation engine against the Claude API (docs/HUMAN_TODO.md).
 *
 * It plays the customer lines of the scripted conversations (`src/testing/scripts.ts`) to
 * the real model, in dry-run mode: nothing is sent and nothing is written to a database.
 * For every conversation it prints the transcript, the tool calls and the token usage of
 * each model call, and checks
 *
 *   - the script's expectations (qualified lead and tool calls for roofing, HVAC, electrical
 *     and remodeling; the emergency, prompt-injection, angry, off-topic and spam behaviour);
 *   - that every model call after the first of a conversation reads from the prompt cache.
 *
 * Usage (the key from the shell or the root .env.local):
 *   ANTHROPIC_API_KEY=... pnpm --filter @repo/ai live:conversations
 *   pnpm --filter @repo/ai live:conversations emergency prompt-injection   # only these
 *   pnpm --filter @repo/ai live:conversations --no-strict                  # CMEK organizations
 *
 * The exit code is 0 when every conversation behaved as specified. It costs a few cents
 * per conversation at the default model and effort.
 */
import path from "node:path";

import { getEnv } from "@repo/core/env";

import { createAnthropicModelClient } from "../src/model/anthropic-client";
import type { ModelClient, ModelRequest, ModelResponse } from "../src/model/types";
import { runScript } from "../src/testing/conversations";
import { ALL_SCRIPTS } from "../src/testing/scripts";

for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(path.resolve(import.meta.dirname, "../../..", file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

interface CallLog {
  readonly request: ModelRequest;
  readonly response: ModelResponse;
}

/** Wraps the client to keep every call of one conversation. */
function recording(inner: ModelClient): ModelClient & { readonly calls: CallLog[] } {
  const calls: CallLog[] = [];
  return {
    name: inner.name,
    calls,
    async call(request) {
      const response = await inner.call(request);
      calls.push({ request, response });
      return response;
    },
  };
}

async function main(): Promise<void> {
  const env = getEnv();
  if (env.ANTHROPIC_API_KEY === undefined) {
    console.error(
      "ANTHROPIC_API_KEY is not set. This check needs a Claude API key (docs/HUMAN_TODO.md, entry 2).",
    );
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  const wanted = args.filter((arg) => !arg.startsWith("--"));
  const strictTools = !args.includes("--no-strict");
  const scripts = ALL_SCRIPTS.filter((script) => wanted.length === 0 || wanted.includes(script.id));
  if (scripts.length === 0) {
    console.error(
      `No such conversation. Known: ${ALL_SCRIPTS.map((script) => script.id).join(", ")}`,
    );
    process.exitCode = 2;
    return;
  }

  const api = createAnthropicModelClient({
    apiKey: env.ANTHROPIC_API_KEY,
    ...(env.ANTHROPIC_BASE_URL === undefined ? {} : { baseUrl: env.ANTHROPIC_BASE_URL }),
  });
  let failed = 0;

  for (const script of scripts) {
    console.log(`\n=== ${script.id}: ${script.title} ===`);
    const model = recording(api);
    const failures: string[] = [];
    try {
      const run = await runScript(script, { model, strictTools });
      failures.push(...run.failures);
      run.turns.forEach((turn, index) => {
        const customer = turn.input.pending
          .map((message) => message.text ?? "(no text)")
          .join(" / ");
        console.log(`\n[${index + 1}] customer: ${customer}`);
        for (const executed of turn.result.actions) {
          console.log(
            `    tool: ${executed.action.type} -> ${executed.outcome.status} ${JSON.stringify(executed.action)}`,
          );
        }
        if (turn.replies.length === 0) console.log(`    bot: (no reply: ${turn.result.outcome})`);
        for (const reply of turn.replies)
          console.log(`    bot: ${reply.replaceAll("\n", "\n         ")}`);
        const notes = turn.result.diagnostics;
        if (notes !== undefined && (notes.guardViolations.length > 0 || notes.rewrites > 0)) {
          console.log(
            `    guard: ${notes.guardViolations.join(", ")} (rewrites: ${notes.rewrites})`,
          );
        }
      });
      const { lead } = run.conversation.state;
      console.log(
        `\n    lead: ${lead.status}, routing ${lead.routing?.outcome ?? "none"}, fields ${Object.keys(lead.fields).join(", ") || "none"}`,
      );
    } catch (error) {
      failures.push(`the run stopped: ${error instanceof Error ? error.message : String(error)}`);
    }

    console.log("\n    model calls (input / output / cache read / cache write tokens):");
    model.calls.forEach((call, index) => {
      const usage = call.response.usage;
      console.log(
        `      ${String(index + 1).padStart(2)}. ${call.response.model} ${call.response.stopReason ?? "?"}: ${usage.inputTokens} / ${usage.outputTokens} / ${usage.cacheReadInputTokens} / ${usage.cacheCreationInputTokens}${call.response.fellBack ? " (fallback model)" : ""}`,
      );
      // The first call of a conversation writes the cache (or reads what another
      // conversation of the same business wrote); every later call has to read.
      if (index > 0 && usage.cacheReadInputTokens === 0) {
        failures.push(`model call ${index + 1} read nothing from the prompt cache`);
      }
    });

    if (failures.length === 0) {
      console.log("\n    PASS");
    } else {
      failed += 1;
      console.log(`\n    FAIL\n${failures.map((failure) => `      - ${failure}`).join("\n")}`);
    }
  }

  console.log(
    `\n${scripts.length - failed} of ${scripts.length} conversations behaved as specified.`,
  );
  if (failed > 0) process.exitCode = 1;
}

await main();
