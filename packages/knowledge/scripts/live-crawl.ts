/**
 * Live check of the website reader against a real site (docs/HUMAN_TODO.md).
 *
 * It fetches the pages of one website through the guarded fetcher, exactly as the job
 * `knowledge-import` does (robots.txt, the site's own pages, most promising first), and for
 * each page prints what would become knowledge facts. Nothing is stored: no database is used.
 * With ANTHROPIC_API_KEY set the facts are extracted by the model; without it, from the
 * structured data the pages publish.
 *
 * Usage:
 *   pnpm --filter @repo/knowledge live:crawl https://www.example-roofing.com
 *   pnpm --filter @repo/knowledge live:crawl https://www.example-roofing.com --pages 5
 *
 * It needs direct outbound access to the site (it does not use an HTTP proxy, on purpose:
 * the connection is pinned to the address that was checked). Also try an address it must
 * refuse, for example http://169.254.169.254/ or http://localhost/: the exit code is 1 and
 * no connection is made.
 */
import path from "node:path";
import { parseArgs } from "node:util";

import { createAnthropicModelClient } from "@repo/ai";
import { getEnv } from "@repo/core/env";
import { defaultSettings } from "@repo/settings";

import { buildExtractionRequest, extractFactsByRule, readExtraction } from "../src/crawl/extract";
import { createFrontier, isCrawlable, sameSite } from "../src/crawl/frontier";
import { extractPage } from "../src/crawl/html";
import { ALLOW_ALL, DISALLOW_ALL, parseRobots, robotsAllow } from "../src/crawl/robots";
import { createSafeFetcher, UnsafeUrlError } from "../src/crawl/safe-fetch";

for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(path.resolve(import.meta.dirname, "../../..", file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2).filter((argument) => argument !== "--"),
    allowPositionals: true,
    options: { pages: { type: "string" } },
  });
  const start = positionals[0];
  if (start === undefined) {
    console.error("Usage: pnpm --filter @repo/knowledge live:crawl <website address> [--pages 5]");
    process.exitCode = 2;
    return;
  }
  const env = getEnv();
  const settings = defaultSettings().values;
  const maxPages = Math.max(1, Number(values.pages ?? "5") || 5);
  const fetcher = createSafeFetcher();
  const model =
    env.ANTHROPIC_API_KEY === undefined
      ? null
      : createAnthropicModelClient({ apiKey: env.ANTHROPIC_API_KEY });
  console.log(model === null ? "Extractor: structured data only (no key)" : "Extractor: model");

  let rules = ALLOW_ALL;
  try {
    const robots = await fetcher.fetch(new URL("/robots.txt", start).toString(), {
      accept: ["text/plain"],
      maxBytes: 512 * 1024,
    });
    rules =
      robots.status >= 200 && robots.status < 300
        ? parseRobots(robots.text())
        : robots.status >= 500
          ? DISALLOW_ALL
          : ALLOW_ALL;
    console.log(`robots.txt: status ${robots.status}, ${rules.rules.length} rules for us`);
  } catch (error) {
    if (!(error instanceof UnsafeUrlError)) throw error;
    if (!error.retryable && error.reason !== "content_type") {
      console.error(`REFUSED (${error.reason}): ${error.message}`);
      process.exitCode = 1;
      return;
    }
    console.log(`robots.txt: ${error.reason}`);
  }

  const frontier = createFrontier(start, maxPages);
  const known: string[] = [];
  let read = 0;
  for (let url = frontier.next(); url !== null; url = frontier.next()) {
    const target = new URL(url);
    if (!robotsAllow(rules, `${target.pathname}${target.search}`)) {
      console.log(`\n${url}\n  skipped: robots.txt`);
      continue;
    }
    try {
      const response = await fetcher.fetch(url);
      if (response.status < 200 || response.status >= 300 || !sameSite(response.url, start)) {
        console.log(`\n${url}\n  skipped: status ${response.status}, ended at ${response.url}`);
        continue;
      }
      const page = extractPage(response.text(), response.url);
      frontier.add(page.links.filter((link) => isCrawlable(link, start)));
      read += 1;
      console.log(
        `\n${response.url}\n  "${page.title ?? ""}" · ${page.text.length} characters · ${page.links.length} links`,
      );
      const result =
        model === null
          ? extractFactsByRule(page)
          : readExtraction(
              await model.call(
                buildExtractionRequest({
                  model: settings["model.knowledge_extraction.model"],
                  effort: settings["model.knowledge_extraction.effort"],
                  fallbacks: settings["model.server_side_fallbacks"],
                  businessName: target.hostname,
                  pageUrl: response.url,
                  page,
                  known,
                }),
              ),
              page,
            );
      for (const fact of result.facts) {
        known.push(`${fact.category}: ${fact.title}`);
        console.log(`  [${fact.category}] ${fact.title}: ${fact.content}`);
      }
      if (Object.keys(result.dropped).length > 0) {
        console.log(`  dropped by the checks: ${JSON.stringify(result.dropped)}`);
      }
    } catch (error) {
      if (!(error instanceof UnsafeUrlError)) throw error;
      console.log(`\n${url}\n  not read (${error.reason}): ${error.message}`);
    }
  }
  console.log(`\n${read} pages read, ${known.length} facts.`);
  process.exitCode = read === 0 ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
