import { callModel, type ModelClient, type ModelResponse } from "@repo/ai";
import {
  type AgencyId,
  type BusinessId,
  type Logger,
  type ModelCallSink,
  type PlaybookDocument,
  type SegmentId,
  type TraceId,
} from "@repo/core";
import {
  alerts,
  and,
  asc,
  businesses,
  type Database,
  deadLetters,
  eq,
  isNotNull,
  type PlaybookOrigin,
} from "@repo/db";
import { defineEventJob, type EventJobDefinition, type RetryCount } from "@repo/jobs";
import { type AppSettings, type EffortLevel, resolveSettings } from "@repo/settings";
import { loadLayers, loadSettings } from "@repo/settings/server";

import { createKnowledgeModelCallSink, discardModelCalls } from "../model-calls";
import {
  generatePlaybook,
  PLAYBOOK_PROMPT_VERSION,
  type PlaybookBrief,
  type PlaybookGenerationStats,
} from "./generate";
import { starterPlaybook } from "./starter";
import {
  findSegment,
  getActivePlaybook,
  getGeneration,
  savePlaybookVersion,
  updateGeneration,
} from "./store";

/**
 * `knowledge-playbook-generate`: writes the playbook of a segment (ARCHITECTURE §4).
 *
 * Steps: `start` (the run, the segment, the settings; a segment that got a playbook in the
 * meantime is reused) → one `model-NN-<label>` step per model call → `store` (the new
 * version, activated). Each model call is its own step, so a retry repeats one call and a
 * call fits in one request of the job endpoint. Progress and the outcome are kept on the
 * `playbook_generations` row, which is what the admin panel shows.
 */

export const PLAYBOOK_GENERATION_JOB_ID = "knowledge-playbook-generate";

const NO_BUSINESS = "00000000-0000-0000-0000-000000000000" as BusinessId;

export interface PlaybookJobDeps {
  readonly db: Database;
  readonly model: ModelClient;
  /**
   * "model": research and write with the Claude API. "starter": store the built-in document
   * (a developer machine without a key; never a hosted deployment).
   */
  readonly generator: "model" | "starter";
  readonly logger: Logger;
  readonly clock?: () => Date;
  /** Longest one model call may take. Default 270 s: under the job endpoint's 300 s. */
  readonly callTimeoutMs?: number;
  readonly strictTools?: boolean;
  readonly retries?: RetryCount;
  /** Tests replace where model calls are recorded. */
  readonly modelCalls?: (trace: {
    readonly businessId: BusinessId | null;
    readonly settingsVersion: string;
  }) => ModelCallSink;
}

type Plan =
  | { readonly kind: "skip"; readonly reason: string; readonly version: number | null }
  | {
      readonly kind: "run";
      readonly brief: PlaybookBrief;
      readonly model: string;
      readonly effort: EffortLevel;
      readonly searchesPerStep: number;
      readonly fallbacks: boolean;
      readonly storeIo: boolean;
      readonly settingsVersion: string;
      /** The business the model calls are recorded under; null when the segment has none. */
      readonly attributionBusinessId: BusinessId | null;
    };

interface Outcome {
  readonly status: "succeeded" | "skipped";
  readonly version: number | null;
  readonly reason?: string;
}

function publicStats(stats: PlaybookGenerationStats): Record<string, unknown> {
  return {
    modelCalls: stats.modelCalls,
    searches: stats.searches,
    searchErrors: stats.searchErrors,
    sourcesSeen: stats.sourcesSeen,
    sourcesCited: stats.sourcesCited,
    sourcesDropped: stats.sourcesDropped,
    repairs: stats.repairs,
    inputTokens: stats.usage.inputTokens,
    outputTokens: stats.usage.outputTokens,
    cacheReadInputTokens: stats.usage.cacheReadInputTokens,
    cacheCreationInputTokens: stats.usage.cacheCreationInputTokens,
  };
}

export function createPlaybookGenerationJob(
  deps: PlaybookJobDeps,
): EventJobDefinition<"playbook.generation_requested"> {
  const { db } = deps;
  const clock = deps.clock ?? (() => new Date());
  const callTimeoutMs = deps.callTimeoutMs ?? 270_000;

  async function start(
    agencyId: AgencyId,
    segmentId: SegmentId,
    generationId: string,
    businessId: BusinessId | null,
  ): Promise<Plan> {
    return db.forAgency(agencyId).run(async (ctx) => {
      const run = await getGeneration(ctx, generationId);
      if (run?.segmentId !== segmentId) {
        return { kind: "skip", reason: "run_not_found", version: null };
      }
      if (run.status === "succeeded" || run.status === "failed") {
        return { kind: "skip", reason: `run_${run.status}`, version: run.version };
      }
      const segment = await findSegment(ctx, segmentId);
      if (segment === null) return { kind: "skip", reason: "segment_not_found", version: null };

      const now = clock();
      const active = await getActivePlaybook(ctx, segmentId);
      if (active !== null && run.reason === "onboarding") {
        // Another request gave the segment a playbook while this one waited: reuse it.
        await updateGeneration(ctx, generationId, {
          status: "succeeded",
          version: active.version,
          stats: { reused: true },
          startedAt: now,
          finishedAt: now,
        });
        return { kind: "skip", reason: "playbook_exists", version: active.version };
      }

      const inSegment = await ctx.tx
        .select({ id: businesses.id, state: businesses.state })
        .from(businesses)
        .where(eq(businesses.segmentId, segmentId))
        .orderBy(asc(businesses.createdAt), asc(businesses.id));
      const requester = inSegment.find((business) => business.id === businessId);
      const attribution = requester ?? inSegment[0] ?? null;
      const settings =
        attribution === null
          ? resolveSettings(
              (await loadLayers(ctx, { scope: "segment", agencyId, segmentId })).layers,
            )
          : await loadSettings(ctx, { agencyId, businessId: attribution.id });
      const values: AppSettings = settings.values;
      const regions = [
        ...new Set(
          inSegment
            .map((business) => business.state?.trim().toUpperCase() ?? "")
            .filter((state) => state.length > 0),
        ),
      ].sort();

      await updateGeneration(ctx, generationId, {
        status: "running",
        startedAt: now,
        stats: { generator: deps.generator, model: values["model.playbook.model"] },
      });
      return {
        kind: "run",
        brief: {
          segment: { slug: segment.slug, name: segment.name, description: segment.description },
          regions,
          today: now.toISOString().slice(0, 10),
        },
        model: values["model.playbook.model"],
        effort: values["model.playbook.effort"],
        searchesPerStep: values["knowledge.playbook_research_searches"],
        fallbacks: values["model.server_side_fallbacks"],
        storeIo: values["data.store_model_io"],
        settingsVersion: settings.version,
        attributionBusinessId: attribution?.id ?? null,
      };
    });
  }

  async function store(
    agencyId: AgencyId,
    segmentId: SegmentId,
    generationId: string,
    result: {
      readonly document: PlaybookDocument;
      readonly origin: PlaybookOrigin;
      readonly changeNote: string;
      readonly stats: Record<string, unknown>;
    },
    traceId: TraceId,
  ): Promise<Outcome> {
    return db.forAgency(agencyId).run(async (ctx) => {
      const run = await getGeneration(ctx, generationId);
      if (run === null) return { status: "skipped", version: null, reason: "run_not_found" };
      // A retry after the transaction below committed: the work is done.
      if (run.status === "succeeded") return { status: "succeeded", version: run.version };
      if (run.status === "failed") {
        return { status: "skipped", version: null, reason: "run_failed" };
      }
      const saved = await savePlaybookVersion(ctx, {
        segmentId,
        document: result.document,
        origin: result.origin,
        changeNote: result.changeNote,
        requireComplete: result.origin === "generated",
        actor:
          run.requestedBy === null
            ? { type: "system", label: PLAYBOOK_GENERATION_JOB_ID }
            : { type: "user", userId: run.requestedBy, label: PLAYBOOK_GENERATION_JOB_ID },
        traceId,
      });
      await updateGeneration(ctx, generationId, {
        status: "succeeded",
        version: saved.version,
        stats: { ...result.stats, step: "done" },
        finishedAt: clock(),
      });
      return { status: "succeeded", version: saved.version };
    });
  }

  return defineEventJob({
    id: PLAYBOOK_GENERATION_JOB_ID,
    name: "Generate a segment playbook",
    trigger: { event: "playbook.generation_requested" },
    // One run per segment at a time; the open-run index in the database guards the same.
    concurrency: { key: "event.data.segmentId", limit: 1 },
    retries: deps.retries ?? 3,

    async handler({ event, step, logger }) {
      const { agencyId, segmentId, generationId, businessId, traceId } = event.data;
      const log = logger.child({ traceId, agencyId, segmentId, generationId });
      const plan = await step.run("start", () =>
        start(agencyId, segmentId, generationId, businessId),
      );
      if (plan.kind === "skip") {
        log.info("playbook.generation_skipped", { reason: plan.reason });
        return { status: "skipped", version: plan.version, reason: plan.reason } satisfies Outcome;
      }

      if (deps.generator === "starter") {
        const starter = starterPlaybook(plan.brief.segment.slug);
        log.warn("playbook.starter_stored", { basedOn: starter.basedOn });
        return step.run("store", () =>
          store(
            agencyId,
            segmentId,
            generationId,
            {
              document: starter.document,
              origin: "starter",
              changeNote:
                "Built-in starter playbook: no model is configured on this machine. Generate again once ANTHROPIC_API_KEY is set.",
              stats: { generator: "starter", basedOn: starter.basedOn },
            },
            traceId,
          ),
        );
      }

      const sink =
        deps.modelCalls?.({
          businessId: plan.attributionBusinessId,
          settingsVersion: plan.settingsVersion,
        }) ??
        (plan.attributionBusinessId === null
          ? discardModelCalls
          : createKnowledgeModelCallSink({
              db,
              logger: log,
              settingsVersion: plan.settingsVersion,
            }));
      // Recorded under the business the playbook was asked for: `model_calls` is a tenant
      // table. A segment without a business has nowhere to record to (the sink discards),
      // and its trace carries the nil id.
      const trace = {
        traceId,
        agencyId,
        businessId: plan.attributionBusinessId ?? NO_BUSINESS,
        conversationId: null,
      };
      let calls = 0;
      const generated = await generatePlaybook(
        plan.brief,
        {
          model: plan.model,
          effort: plan.effort,
          searchesPerStep: plan.searchesPerStep,
          fallbacks: plan.fallbacks,
          callTimeoutMs,
          ...(deps.strictTools === undefined ? {} : { strictTools: deps.strictTools }),
        },
        (request, label) => {
          calls += 1;
          const ordinal = calls;
          return step.run(
            `model-${String(ordinal).padStart(2, "0")}-${label}`,
            async (): Promise<ModelResponse> => {
              await db.forAgency(agencyId).run((ctx) =>
                updateGeneration(ctx, generationId, {
                  stats: { step: label, modelCalls: ordinal },
                }),
              );
              return callModel(
                deps.model,
                // The SDK retries a timeout by itself; the signal caps the whole call so a
                // step always ends before the job endpoint does.
                { ...request, signal: AbortSignal.timeout(callTimeoutMs + 10_000) },
                {
                  trace,
                  promptVersion: PLAYBOOK_PROMPT_VERSION,
                  sink,
                  logger: log,
                  storeIo: plan.storeIo,
                  clock,
                },
              );
            },
          );
        },
      );
      log.info("playbook.generated", publicStats(generated.stats));

      return step.run("store", () =>
        store(
          agencyId,
          segmentId,
          generationId,
          {
            document: generated.document,
            origin: "generated",
            changeNote: `Generated from web research: ${generated.stats.searches} searches, ${generated.stats.sourcesCited} sources cited.`,
            stats: publicStats(generated.stats),
          },
          traceId,
        ),
      );
    },

    async onFailure({ event, error, runId, logger }) {
      const { agencyId, segmentId, generationId, businessId, traceId } = event.data;
      const message =
        error.code === null
          ? "The playbook could not be generated. The logs under the run's trace id say why."
          : error.message;
      await db.forAgency(agencyId).run(async (ctx) => {
        const closed = await updateGeneration(ctx, generationId, {
          status: "failed",
          errorCode: error.code ?? "internal",
          errorMessage: message,
          finishedAt: clock(),
        });
        if (!closed) return;
        await ctx.tx.insert(deadLetters).values({
          agencyId,
          businessId: null,
          source: PLAYBOOK_GENERATION_JOB_ID,
          eventName: event.name,
          eventId: event.id,
          traceId,
          errorCode: error.code,
          errorMessage: message.slice(0, 2000),
          retryable: false,
          payload: { segmentId, generationId, runId },
        });
        // An in-app alert needs a business to hang on: the one that was being onboarded.
        if (businessId !== null) {
          const [business] = await ctx.tx
            .select({ id: businesses.id })
            .from(businesses)
            .where(and(eq(businesses.id, businessId), isNotNull(businesses.segmentId)))
            .limit(1);
          if (business !== undefined) {
            await ctx.tx
              .insert(alerts)
              .values({
                agencyId,
                businessId: business.id,
                kind: "playbook_generation_failed",
                severity: "warning",
                channel: "in_app",
                recipient: "agency",
                subject: "The industry playbook could not be generated",
                payload: { segmentId, generationId, errorCode: error.code },
                dedupeKey: `playbook-generation-${generationId}`,
              })
              .onConflictDoNothing();
          }
        }
      });
      logger.error("playbook.generation_failed", {
        traceId,
        agencyId,
        segmentId,
        generationId,
        code: error.code,
      });
    },
  });
}
