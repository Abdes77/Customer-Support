/**
 * Live check of playbook generation against the Claude API and its web search tool
 * (docs/HUMAN_TODO.md).
 *
 * It researches and writes the playbook of each trade named on the command line (default:
 * roofing and pest control), exactly as the job `knowledge-playbook-generate` does, but
 * without a database: nothing is stored. For every trade it prints each model call (label,
 * stop reason, searches, tokens, seconds), the sections of the finished playbook, its price
 * norms and its sources, and it checks that the document is complete, passes every rule and
 * cites only pages the search returned.
 *
 * Usage (the key from the shell or the root .env.local):
 *   ANTHROPIC_API_KEY=... pnpm --filter @repo/knowledge live:playbook
 *   pnpm --filter @repo/knowledge live:playbook "Pest control"            # only this trade
 *   pnpm --filter @repo/knowledge live:playbook Roofing --region CO --out /tmp/playbooks
 *   pnpm --filter @repo/knowledge live:playbook --no-strict               # CMEK organizations
 *   pnpm --filter @repo/knowledge live:playbook --effort medium --searches 3
 *
 * The exit code is 0 when every playbook was generated and passed. Expect several minutes
 * and a few dollars per trade at the default model and effort (web searches are billed per
 * search on top of the tokens).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { createAnthropicModelClient } from "@repo/ai";
import { PLAYBOOK_SECTIONS, formatPriceNorm } from "@repo/core";
import { getEnv } from "@repo/core/env";
import { defaultSettings, EFFORT_LEVELS, type EffortLevel } from "@repo/settings";

import { completenessIssues, parsePlaybookDocument } from "../src/playbooks/document";
import { generatePlaybook, PlaybookGenerationError } from "../src/playbooks/generate";
import { segmentSlug } from "../src/playbooks/onboarding";

for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(path.resolve(import.meta.dirname, "../../..", file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
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
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2).filter((argument) => argument !== "--"),
    allowPositionals: true,
    options: {
      region: { type: "string", multiple: true },
      out: { type: "string" },
      effort: { type: "string" },
      searches: { type: "string" },
      model: { type: "string" },
      "no-strict": { type: "boolean" },
    },
  });
  const settings = defaultSettings().values;
  const effort = (values.effort ?? settings["model.playbook.effort"]) as EffortLevel;
  if (!(EFFORT_LEVELS as readonly string[]).includes(effort)) {
    console.error(`--effort is one of: ${EFFORT_LEVELS.join(", ")}`);
    process.exitCode = 2;
    return;
  }
  const searches = Number(values.searches ?? settings["knowledge.playbook_research_searches"]);
  const trades = positionals.length > 0 ? positionals : ["Roofing", "Pest control"];
  const api = createAnthropicModelClient({
    apiKey: env.ANTHROPIC_API_KEY,
    ...(env.ANTHROPIC_BASE_URL === undefined ? {} : { baseUrl: env.ANTHROPIC_BASE_URL }),
  });

  let failed = 0;
  for (const trade of trades) {
    console.log(`\n=== ${trade} ===`);
    const started = Date.now();
    try {
      const generated = await generatePlaybook(
        {
          segment: { slug: segmentSlug(trade), name: trade, description: null },
          regions: values.region ?? [],
          today: new Date().toISOString().slice(0, 10),
        },
        {
          model: values.model ?? settings["model.playbook.model"],
          effort,
          searchesPerStep: Number.isFinite(searches) && searches >= 1 ? searches : 5,
          fallbacks: settings["model.server_side_fallbacks"],
          strictTools: values["no-strict"] !== true,
        },
        async (request, label) => {
          const before = Date.now();
          const response = await api.call(request);
          const searched = response.content.filter(
            (block) => block.type === "server_tool_use" && block.name === "web_search",
          ).length;
          console.log(
            `  ${label.padEnd(22)} ${String(response.stopReason).padEnd(10)} searches ${searched}  in ${response.usage.inputTokens}  out ${response.usage.outputTokens}  cache read ${response.usage.cacheReadInputTokens}  ${((Date.now() - before) / 1000).toFixed(1)} s${response.fellBack ? "  (fallback model)" : ""}`,
          );
          return response;
        },
      );
      const { document, stats } = generated;
      const problems = [
        ...(() => {
          const parsed = parsePlaybookDocument(document);
          return parsed.ok ? [] : parsed.issues;
        })(),
        ...completenessIssues(document),
      ];
      console.log(
        `  done in ${((Date.now() - started) / 1000).toFixed(0)} s: ${stats.modelCalls} model calls, ${stats.searches} searches (${stats.searchErrors} failed), ${stats.sourcesSeen} pages seen, ${stats.sourcesCited} cited, ${stats.sourcesDropped} dropped, ${stats.repairs} corrections`,
      );
      for (const section of PLAYBOOK_SECTIONS) {
        console.log(`  ${section.padEnd(24)} ${document[section].length}`);
      }
      for (const norm of document.priceNorms) {
        console.log(`  price: ${norm.job}: ${formatPriceNorm(norm)}`);
      }
      for (const source of document.sources) console.log(`  source: ${source.url}`);
      if (values.out !== undefined) {
        mkdirSync(values.out, { recursive: true });
        const file = path.join(values.out, `${segmentSlug(trade)}.json`);
        writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
        console.log(`  written to ${file}`);
      }
      if (problems.length > 0) {
        failed += 1;
        console.error(`  FAILED: the document does not pass the checks:`);
        for (const problem of problems) console.error(`    ${problem.path}: ${problem.message}`);
      } else {
        console.log("  PASSED: complete, valid, every source from the search results");
      }
    } catch (error) {
      failed += 1;
      if (error instanceof PlaybookGenerationError) {
        console.error(`  FAILED (${error.failure}): ${error.message}`);
        console.error(`  ${JSON.stringify(error.details)}`);
      } else {
        console.error(`  FAILED: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
