import { callModel, type ModelClient } from "@repo/ai";
import {
  type AgencyId,
  type BusinessId,
  type Logger,
  type ModelCallSink,
  newTraceId,
  NotFoundError,
  type TraceId,
  type UserId,
  ValidationError,
} from "@repo/core";
import {
  alerts,
  and,
  businesses,
  type Database,
  deadLetters,
  eq,
  importRuns,
  inArray,
  knowledgeItems,
  recordSystemAudit,
  sql,
} from "@repo/db";
import {
  defineEventJob,
  type EventJobDefinition,
  type EventSender,
  jobEvent,
  type RetryCount,
} from "@repo/jobs";
import type { EffortLevel } from "@repo/settings";
import { loadSettings } from "@repo/settings/server";

import { createKnowledgeModelCallSink } from "../model-calls";
import {
  buildExtractionRequest,
  extractFactsByRule,
  type ExtractionResult,
  EXTRACTION_PROMPT_VERSION,
  readExtraction,
} from "./extract";
import { createFrontier, isCrawlable, sameSite } from "./frontier";
import { extractPage } from "./html";
import { ALLOW_ALL, DISALLOW_ALL, parseRobots, robotsAllow, type RobotsRules } from "./robots";
import { type SafeFetcher, UnsafeUrlError } from "./safe-fetch";
import { storeWebsiteFacts } from "./store";

/**
 * `knowledge-import`: reads a business's website into knowledge facts (ARCHITECTURE §4).
 *
 * Steps: `start` (the run, the business, the settings) → `robots` → one `page-N` step per
 * page (fetch through the guarded fetcher, extract, store; one model call at most) with a
 * short wait between pages → `finish`. The pages to visit are decided from the step results
 * alone, so a replay visits the same pages in the same order.
 *
 * CSV and API imports do not come through here: they are bounded (5 MB, 5,000 rows) and run
 * inside the request that brings the data.
 */

export const KNOWLEDGE_IMPORT_JOB_ID = "knowledge-import";

/** A crawl run that has not moved for this long is taken for dead. */
const CRAWL_STALE_SECONDS = 30 * 60;
/** Links one page may add to the queue. */
const MAX_LINKS_PER_PAGE = 60;
/** Pages with less text than this state nothing worth a model call. */
const MIN_PAGE_CHARS = 200;

export interface CrawlJobDeps {
  readonly db: Database;
  readonly model: ModelClient;
  /** "model": facts are extracted by the Claude API. "rules": from structured data only. */
  readonly extractor: "model" | "rules";
  readonly fetcher: SafeFetcher;
  readonly logger: Logger;
  readonly clock?: () => Date;
  /** Wait between two pages of one site. Default one second. */
  readonly pageDelayMs?: number;
  readonly strictTools?: boolean;
  readonly retries?: RetryCount;
  readonly modelCalls?: (settingsVersion: string) => ModelCallSink;
}

type Plan =
  | { readonly kind: "skip"; readonly reason: string }
  | {
      readonly kind: "run";
      readonly startUrl: string;
      readonly businessName: string;
      readonly maxPages: number;
      readonly model: string;
      readonly effort: EffortLevel;
      readonly fallbacks: boolean;
      readonly storeIo: boolean;
      readonly settingsVersion: string;
    };

type RobotsOutcome =
  | { readonly kind: "rules"; readonly rules: RobotsRules }
  /** The address itself may not be read (not a public website). */
  | { readonly kind: "refused"; readonly message: string };

interface PageOutcome {
  readonly url: string;
  readonly status: "read" | "disallowed" | "unreadable" | "off_site";
  /** Why the page was not read; safe to show. */
  readonly problem: string | null;
  readonly links: readonly string[];
  readonly created: number;
  readonly updated: number;
  readonly kept: number;
  readonly dropped: number;
}

function websiteAddress(value: string | null): string | null {
  if (value === null || value.trim().length === 0) return null;
  const raw = /^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

const OPEN = ["pending", "running"] as const;

export const crawlEventId = (importRunId: string) => `knowledge-import-${importRunId}`;

export interface CrawlRequestDeps {
  readonly db: Database;
  readonly events: EventSender;
  readonly logger: Logger;
  readonly clock?: () => Date;
}

/**
 * Asks for the business's website to be read. Refused when the business has website reading
 * switched off (`knowledge.website_crawl`) or has no usable website address. One crawl per
 * business at a time: a second request joins the open run.
 */
export async function requestWebsiteCrawl(
  deps: CrawlRequestDeps,
  input: {
    readonly agencyId: AgencyId;
    readonly businessId: BusinessId;
    readonly requestedBy: UserId | null;
    readonly traceId?: TraceId;
  },
): Promise<{ readonly importRunId: string; readonly started: boolean }> {
  const now = (deps.clock ?? (() => new Date()))();
  const traceId = input.traceId ?? newTraceId();
  const tenant = { agencyId: input.agencyId, businessId: input.businessId };
  const opened = await deps.db.forBusiness(input.businessId, tenant).run(async (ctx) => {
    const [business] = await ctx.tx
      .select({ name: businesses.name, websiteUrl: businesses.websiteUrl })
      .from(businesses)
      .where(eq(businesses.id, input.businessId))
      .limit(1);
    if (business === undefined) {
      throw new NotFoundError("Business not found.", { details: { businessId: input.businessId } });
    }
    const settings = await loadSettings(ctx, tenant);
    if (!settings.values["knowledge.website_crawl"]) {
      throw new ValidationError(
        'Reading the website is switched off for this business. Switch on "Read the business website" in its knowledge settings first.',
        { details: { setting: "knowledge.website_crawl" } },
      );
    }
    const address = websiteAddress(business.websiteUrl);
    if (address === null) {
      throw new ValidationError(
        "The business has no website address in its profile, or the address is not a web address.",
      );
    }
    await ctx.tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`crawl:${input.businessId}`}, 0))`,
    );
    const crawls = and(
      eq(importRuns.businessId, input.businessId),
      eq(importRuns.kind, "website_crawl"),
      inArray(importRuns.status, [...OPEN]),
    );
    await ctx.tx
      .update(importRuns)
      .set({
        status: "failed",
        errors: [{ row: null, column: null, message: "The run stopped without finishing." }],
        finishedAt: now,
      })
      .where(
        and(
          crawls,
          sql`${importRuns.updatedAt} < now() - make_interval(secs => ${CRAWL_STALE_SECONDS})`,
        ),
      );
    const [open] = await ctx.tx
      .select({ id: importRuns.id })
      .from(importRuns)
      .where(crawls)
      .limit(1);
    if (open !== undefined) return { importRunId: open.id, started: false };
    const [run] = await ctx.tx
      .insert(importRuns)
      .values({
        ...tenant,
        kind: "website_crawl",
        status: "pending",
        fileName: address.slice(0, 255),
        createdBy: input.requestedBy,
      })
      .returning({ id: importRuns.id });
    if (run === undefined) throw new Error("Insert into import_runs returned no row");
    await recordSystemAudit(
      ctx,
      input.requestedBy === null
        ? { type: "system", label: KNOWLEDGE_IMPORT_JOB_ID }
        : { type: "user", userId: input.requestedBy },
      {
        action: "knowledge.crawl_requested",
        targetType: "import_run",
        targetId: run.id,
        summary: `Website reading requested for ${business.name}`,
        traceId,
      },
    );
    return { importRunId: run.id, started: true };
  });
  if (!opened.started) return opened;
  try {
    await deps.events.send([
      jobEvent("knowledge.import_requested", crawlEventId(opened.importRunId), {
        traceId,
        agencyId: input.agencyId,
        businessId: input.businessId,
        importRunId: opened.importRunId,
      }),
    ]);
  } catch (error) {
    await deps.db.forBusiness(input.businessId, tenant).run((ctx) =>
      ctx.tx
        .update(importRuns)
        .set({
          status: "failed",
          errors: [{ row: null, column: null, message: "The job could not be queued." }],
          finishedAt: now,
        })
        .where(eq(importRuns.id, opened.importRunId)),
    );
    deps.logger.error("knowledge.crawl_not_queued", {
      traceId,
      businessId: input.businessId,
      importRunId: opened.importRunId,
      error,
    });
    throw error;
  }
  return opened;
}

export function createKnowledgeImportJob(
  deps: CrawlJobDeps,
): EventJobDefinition<"knowledge.import_requested"> {
  const { db, fetcher } = deps;
  const clock = deps.clock ?? (() => new Date());
  const pageDelayMs = deps.pageDelayMs ?? 1000;

  const openRun = (importRunId: string) =>
    and(eq(importRuns.id, importRunId), inArray(importRuns.status, [...OPEN]));

  async function start(tenant: {
    agencyId: AgencyId;
    businessId: BusinessId;
    importRunId: string;
  }): Promise<Plan> {
    return db.forBusiness(tenant.businessId, tenant).run(async (ctx) => {
      const [run] = await ctx.tx
        .select({ kind: importRuns.kind, status: importRuns.status })
        .from(importRuns)
        .where(eq(importRuns.id, tenant.importRunId))
        .limit(1);
      if (run === undefined) return { kind: "skip", reason: "run_not_found" };
      if (run.kind !== "website_crawl") return { kind: "skip", reason: "not_a_crawl" };
      if (run.status !== "pending" && run.status !== "running") {
        return { kind: "skip", reason: `run_${run.status}` };
      }
      const fail = async (message: string): Promise<Plan> => {
        await ctx.tx
          .update(importRuns)
          .set({
            status: "failed",
            errors: [{ row: null, column: null, message }],
            finishedAt: clock(),
          })
          .where(openRun(tenant.importRunId));
        return { kind: "skip", reason: "not_allowed" };
      };
      const [business] = await ctx.tx
        .select({ name: businesses.name, websiteUrl: businesses.websiteUrl })
        .from(businesses)
        .where(eq(businesses.id, tenant.businessId))
        .limit(1);
      const settings = await loadSettings(ctx, tenant);
      const values = settings.values;
      // Checked again here: the setting may have been switched off since the request.
      if (!values["knowledge.website_crawl"]) {
        return fail("Reading the website is switched off for this business.");
      }
      const startUrl = websiteAddress(business?.websiteUrl ?? null);
      if (business === undefined || startUrl === null) {
        return fail("The business has no usable website address.");
      }
      await ctx.tx
        .update(importRuns)
        .set({ status: "running", startedAt: clock() })
        .where(openRun(tenant.importRunId));
      return {
        kind: "run",
        startUrl,
        businessName: business.name,
        maxPages: values["knowledge.crawl_max_pages"],
        model: values["model.knowledge_extraction.model"],
        effort: values["model.knowledge_extraction.effort"],
        fallbacks: values["model.server_side_fallbacks"],
        storeIo: values["data.store_model_io"],
        settingsVersion: settings.version,
      };
    });
  }

  async function readRobots(startUrl: string): Promise<RobotsOutcome> {
    const address = new URL("/robots.txt", startUrl).toString();
    try {
      const response = await fetcher.fetch(address, {
        maxBytes: 512 * 1024,
        timeoutMs: 10_000,
        accept: ["text/plain"],
      });
      if (response.status >= 200 && response.status < 300) {
        return { kind: "rules", rules: parseRobots(response.text()) };
      }
      // RFC 9309: "no robots.txt" lets us in; a server error keeps us out.
      return { kind: "rules", rules: response.status >= 500 ? DISALLOW_ALL : ALLOW_ALL };
    } catch (error) {
      if (!(error instanceof UnsafeUrlError)) throw error;
      // Something that is not text where robots.txt should be: treat as none.
      if (error.reason === "content_type") return { kind: "rules", rules: ALLOW_ALL };
      if (!error.retryable && error.reason !== "too_large" && error.reason !== "redirect") {
        return { kind: "refused", message: error.message };
      }
      return { kind: "rules", rules: DISALLOW_ALL };
    }
  }

  async function readPage(
    tenant: { agencyId: AgencyId; businessId: BusinessId; importRunId: string },
    plan: Extract<Plan, { kind: "run" }>,
    rules: RobotsRules,
    url: string,
    ordinal: number,
    traceId: TraceId,
    log: Logger,
  ): Promise<PageOutcome> {
    const none = { links: [], created: 0, updated: 0, kept: 0, dropped: 0 };
    const target = new URL(url);
    if (!robotsAllow(rules, `${target.pathname}${target.search}`)) {
      return {
        url,
        status: "disallowed",
        problem: rules.available
          ? "The site's robots.txt asks not to read this page."
          : "The site's robots.txt could not be read, so the site was not read.",
        ...none,
      };
    }
    let html: string;
    let finalUrl: string;
    try {
      const response = await fetcher.fetch(url);
      if (response.status < 200 || response.status >= 300) {
        return {
          url,
          status: "unreadable",
          problem: `The page answered with status ${response.status}.`,
          ...none,
        };
      }
      html = response.text();
      finalUrl = response.url;
    } catch (error) {
      if (!(error instanceof UnsafeUrlError)) throw error;
      return { url, status: "unreadable", problem: error.message, ...none };
    }
    if (!sameSite(finalUrl, plan.startUrl)) {
      return {
        url,
        status: "off_site",
        problem: "The page redirects to another website.",
        ...none,
      };
    }
    const page = extractPage(html, finalUrl);
    const links = page.links
      .filter((link) => isCrawlable(link, plan.startUrl))
      .filter((link) => {
        const parsed = new URL(link);
        return robotsAllow(rules, `${parsed.pathname}${parsed.search}`);
      })
      .slice(0, MAX_LINKS_PER_PAGE);

    let extraction: ExtractionResult = { facts: [], dropped: {} };
    if (deps.extractor === "rules") {
      extraction = extractFactsByRule(page);
    } else if (page.text.length >= MIN_PAGE_CHARS) {
      const known = await db
        .forBusiness(tenant.businessId, tenant)
        .run(
          (ctx) =>
            ctx.tx
              .select({ category: knowledgeItems.category, title: knowledgeItems.title })
              .from(knowledgeItems)
              .where(eq(knowledgeItems.status, "active"))
              .orderBy(knowledgeItems.category, knowledgeItems.position, knowledgeItems.id)
              .limit(300),
          { readOnly: true },
        );
      const sink =
        deps.modelCalls?.(plan.settingsVersion) ??
        createKnowledgeModelCallSink({ db, logger: log, settingsVersion: plan.settingsVersion });
      const response = await callModel(
        deps.model,
        buildExtractionRequest({
          model: plan.model,
          effort: plan.effort,
          fallbacks: plan.fallbacks,
          businessName: plan.businessName,
          pageUrl: finalUrl,
          page,
          known: known.map((fact) => `${fact.category}: ${fact.title}`),
          ...(deps.strictTools === undefined ? {} : { strictTools: deps.strictTools }),
        }),
        {
          trace: { traceId, ...tenant, conversationId: null },
          promptVersion: EXTRACTION_PROMPT_VERSION,
          sink,
          logger: log,
          storeIo: plan.storeIo,
          clock,
        },
      );
      extraction = readExtraction(response, page);
    }

    const counts = await db.forBusiness(tenant.businessId, tenant).run(async (ctx) => {
      const stored = await storeWebsiteFacts(ctx, {
        importRunId: tenant.importRunId,
        pageUrl: finalUrl,
        facts: extraction.facts,
      });
      await ctx.tx
        .update(importRuns)
        .set({ stats: sql`${importRuns.stats} || ${JSON.stringify({ pages: ordinal })}::jsonb` })
        .where(openRun(tenant.importRunId));
      return stored;
    });
    return {
      url,
      status: "read",
      problem: null,
      links,
      created: counts.created,
      updated: counts.updated,
      kept: counts.kept + counts.unchanged + counts.overLimit,
      dropped: Object.values(extraction.dropped).reduce((sum, value) => sum + value, 0),
    };
  }

  return defineEventJob({
    id: KNOWLEDGE_IMPORT_JOB_ID,
    name: "Read a business website into knowledge facts",
    trigger: { event: "knowledge.import_requested" },
    concurrency: { key: "event.data.businessId", limit: 1 },
    retries: deps.retries ?? 3,

    async handler({ event, step, logger }) {
      const { agencyId, businessId, importRunId, traceId } = event.data;
      const tenant = { agencyId, businessId, importRunId };
      const log = logger.child({ traceId, businessId, importRunId });
      const plan = await step.run("start", () => start(tenant));
      if (plan.kind === "skip") {
        log.info("knowledge.crawl_skipped", { reason: plan.reason });
        return { status: "skipped", reason: plan.reason };
      }

      const robots = await step.run("robots", () => readRobots(plan.startUrl));
      const pages: PageOutcome[] = [];
      if (robots.kind === "rules") {
        const frontier = createFrontier(plan.startUrl, plan.maxPages);
        for (let ordinal = 1; ; ordinal += 1) {
          const url = frontier.next();
          if (url === null) break;
          if (ordinal > 1 && pageDelayMs > 0) await step.sleep(`wait-${ordinal}`, pageDelayMs);
          const page = await step.run(`page-${ordinal}`, () =>
            readPage(tenant, plan, robots.rules, url, ordinal, traceId, log),
          );
          pages.push(page);
          frontier.add(page.links);
        }
      }

      return step.run("finish", () =>
        db.forBusiness(businessId, tenant).run(async (ctx) => {
          const read = pages.filter((page) => page.status === "read");
          const problems = [
            ...(robots.kind === "refused"
              ? [{ row: null, column: plan.startUrl.slice(0, 300), message: robots.message }]
              : []),
            ...pages
              .filter((page) => page.problem !== null)
              .map((page) => ({
                row: null,
                column: page.url.slice(0, 300),
                message: page.problem ?? "",
              })),
          ].slice(0, 50);
          const total = (pick: (page: PageOutcome) => number) =>
            read.reduce((sum, page) => sum + pick(page), 0);
          const stats = {
            pages: read.length,
            pagesSkipped: pages.length - read.length,
            factsCreated: total((page) => page.created),
            factsUpdated: total((page) => page.updated),
            factsKept: total((page) => page.kept),
            factsDropped: total((page) => page.dropped),
            extractor: deps.extractor,
          };
          const status =
            read.length === 0 ? "failed" : problems.length > 0 ? "partial" : "succeeded";
          const closed = await ctx.tx
            .update(importRuns)
            .set({ status, stats, errors: problems, finishedAt: clock() })
            .where(openRun(importRunId))
            .returning({ id: importRuns.id });
          if (closed.length > 0) {
            await recordSystemAudit(
              ctx,
              { type: "system", label: KNOWLEDGE_IMPORT_JOB_ID },
              {
                action: "knowledge.crawl",
                targetType: "import_run",
                targetId: importRunId,
                summary: `Website read: ${status}; ${stats.pages} pages, ${stats.factsCreated} facts added, ${stats.factsUpdated} updated`,
                metadata: stats,
                traceId,
              },
            );
          }
          log.info("knowledge.crawl_finished", { status, ...stats });
          return { status, ...stats };
        }),
      );
    },

    async onFailure({ event, error, runId, logger }) {
      const { agencyId, businessId, importRunId, traceId } = event.data;
      const message =
        error.code === null
          ? "The website could not be read. The logs under the run's trace id say why."
          : error.message;
      await db.forBusiness(businessId, { agencyId }).run(async (ctx) => {
        const closed = await ctx.tx
          .update(importRuns)
          .set({
            status: "failed",
            errors: [{ row: null, column: null, message }],
            finishedAt: clock(),
          })
          .where(openRun(importRunId))
          .returning({ id: importRuns.id });
        if (closed.length === 0) return;
        await ctx.tx.insert(deadLetters).values({
          ...ctx.tenant,
          source: KNOWLEDGE_IMPORT_JOB_ID,
          eventName: event.name,
          eventId: event.id,
          traceId,
          errorCode: error.code,
          errorMessage: message.slice(0, 2000),
          retryable: false,
          payload: { importRunId, runId },
        });
        await ctx.tx
          .insert(alerts)
          .values({
            ...ctx.tenant,
            kind: "knowledge_import_failed",
            severity: "info",
            channel: "in_app",
            recipient: "agency",
            subject: "The business website could not be read",
            payload: { importRunId, errorCode: error.code },
            dedupeKey: `knowledge-import-${importRunId}`,
          })
          .onConflictDoNothing();
      });
      logger.error("knowledge.crawl_failed", {
        traceId,
        businessId,
        importRunId,
        code: error.code,
      });
    },
  });
}
