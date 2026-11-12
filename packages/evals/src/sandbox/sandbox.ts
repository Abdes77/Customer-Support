import { randomBytes } from "node:crypto";

import type { ModelClient } from "@repo/ai";
import type {
  ActionOutcome,
  BusinessId,
  BusinessProfile,
  ConversationEngine,
  EngineAction,
  KnowledgeRetriever,
  Logger,
  PlaybookSnapshot,
  ToolExecutionContext,
} from "@repo/core";
import {
  alerts,
  attachments,
  businesses,
  contacts,
  conversations,
  conversationTurns,
  count,
  type Database,
  deadLetters,
  knowledgeItems,
  leadEvents,
  leadFields,
  leadReports,
  leads,
  messages,
  modelCalls,
  playbookVersions,
  routingDecisions,
  segments,
} from "@repo/db";
import { createTestDatabase } from "@repo/db/testing";
import { createDomainComposition, loadBusinessProfile } from "@repo/pipeline";

import { EVAL_BUSINESSES, EVAL_SEGMENTS, type EvalSegment } from "../fixtures/businesses";
import { evalPlaybook } from "../fixtures/playbooks";

/**
 * The evaluation sandbox: a throwaway PostgreSQL database holding the evaluation
 * businesses, with the product's own domain composition on top of it.
 *
 * What comes from production code, unchanged: the engine (`createDomainComposition`, the
 * wiring every live turn uses), the knowledge retriever (full-text search over the stored
 * facts), the playbook loader and the business profile loader. What does not: the lead
 * record, photos and calendar slots of a conversation live in the dry run's memory, because
 * `mode: "dry_run"` writes nothing (invariant I8), and a multi-turn conversation needs its
 * lead to carry over from turn to turn.
 *
 * The database is created from the migrated template of `@repo/db/testing` and dropped on
 * `dispose()`. Nothing outside it is touched and nothing is sent anywhere.
 */

export interface SandboxBusiness {
  readonly segment: EvalSegment;
  readonly profile: BusinessProfile;
  /** The segment's active playbook as the production loader returns it. */
  readonly playbook: PlaybookSnapshot | null;
}

/** Tables a dry run must leave empty: everything a live turn writes. */
const TURN_TABLES = {
  contacts,
  conversations,
  messages,
  attachments,
  conversation_turns: conversationTurns,
  leads,
  lead_fields: leadFields,
  lead_reports: leadReports,
  routing_decisions: routingDecisions,
  lead_events: leadEvents,
  model_calls: modelCalls,
  alerts,
  dead_letters: deadLetters,
} as const;

export interface EvalSandbox {
  readonly db: Database;
  /** The production engine, with the given model behind it. */
  readonly engine: ConversationEngine;
  /** The production retriever over the sandbox's knowledge items. */
  readonly knowledge: KnowledgeRetriever;
  business(segment: EvalSegment): SandboxBusiness;
  /**
   * What production's own handler says to an action, where a handler decides from the
   * settings and the channel alone (`request_photo`). Null: no such handler; the dry run's
   * memory decides.
   */
  settingsVerdict(
    action: EngineAction,
    context: ToolExecutionContext,
  ): Promise<ActionOutcome | null>;
  /** Rows in the tables a turn writes. All zero as long as invariant I8 holds. */
  turnRowCounts(): Promise<Record<string, number>>;
  dispose(): Promise<void>;
}

export interface EvalSandboxOptions {
  /** The model behind the engine: the Claude API in a live run, the offline model otherwise. */
  readonly model: ModelClient;
  readonly logger: Logger;
  /** Default: all six. */
  readonly segments?: readonly EvalSegment[];
}

export async function createEvalSandbox(options: EvalSandboxOptions): Promise<EvalSandbox> {
  const wanted = options.segments ?? EVAL_SEGMENTS;
  const database = await createTestDatabase();
  try {
    const { db, admin } = database;
    const slug = `evals-${randomBytes(4).toString("hex")}`;
    const { id: agencyId } = await db.platform.createAgency({ name: "Evaluation agency", slug });

    const ids = new Map<EvalSegment, BusinessId>();
    for (const segment of wanted) {
      const business = EVAL_BUSINESSES[segment];
      const [segmentRow] = await admin
        .insert(segments)
        .values({ agencyId, slug: business.segmentSlug, name: business.segmentName })
        .returning({ id: segments.id });
      if (segmentRow === undefined) throw new Error("The segment insert returned no row.");
      const playbook = evalPlaybook(segment, business.segmentSlug);
      await admin.insert(playbookVersions).values({
        agencyId,
        segmentId: segmentRow.id,
        version: 1,
        isActive: true,
        origin: playbook.origin,
        document: playbook.document,
        changeNote: "Evaluation fixture",
      });
      const [businessRow] = await admin
        .insert(businesses)
        .values({
          agencyId,
          segmentId: segmentRow.id,
          name: business.name,
          slug: business.slug,
          status: "active",
          timezone: business.timezone,
          websiteUrl: business.contact.websiteUrl,
          phone: business.contact.phone,
          email: business.contact.email,
          city: business.contact.city,
          state: business.contact.state,
          postalCode: business.contact.postalCode,
        })
        .returning({ id: businesses.id });
      if (businessRow === undefined) throw new Error("The business insert returned no row.");
      await admin.insert(knowledgeItems).values(
        business.facts.map((item, position) => ({
          agencyId,
          businessId: businessRow.id,
          category: item.category,
          title: item.title,
          content: item.content,
          source: "manual",
          importKey: `eval:${item.key}`,
          position,
        })),
      );
      ids.set(segment, businessRow.id);
    }

    const composition = createDomainComposition({
      db,
      logger: options.logger,
      model: options.model,
    });

    // Loaded once, through the same loaders a live turn uses: fixtures do not change.
    const loaded = new Map<EvalSegment, SandboxBusiness>();
    for (const [segment, businessId] of ids) {
      const entry = await db.forBusiness(businessId, { agencyId }).run(async (ctx) => {
        const profile = await loadBusinessProfile(ctx);
        if (profile === null)
          throw new Error(`The sandbox business for ${segment} has no segment.`);
        return { segment, profile, playbook: await composition.loaders.playbook(ctx, profile) };
      });
      loaded.set(segment, entry);
    }

    return {
      db,
      engine: composition.engine,
      knowledge: composition.knowledge,
      business(segment) {
        const entry = loaded.get(segment);
        if (entry === undefined) {
          throw new Error(`The sandbox was created without the ${segment} business.`);
        }
        return entry;
      },
      async settingsVerdict(action, context) {
        const dryRun = { ...context, mode: "dry_run" as const };
        switch (action.type) {
          case "request_photo": {
            const handler = composition.actions.find("request_photo");
            return handler?.type === "request_photo" ? handler.handle(action, dryRun) : null;
          }
          // C12: scheduling decides from the settings alone in a dry run (no calendar is
          // read, nothing is booked): booking switched off, no calendar, Calendly links.
          case "offer_times": {
            const handler = composition.actions.find("offer_times");
            return handler?.type === "offer_times" ? handler.handle(action, dryRun) : null;
          }
          case "book_meeting": {
            const handler = composition.actions.find("book_meeting");
            return handler?.type === "book_meeting" ? handler.handle(action, dryRun) : null;
          }
          case "cancel_meeting": {
            const handler = composition.actions.find("cancel_meeting");
            return handler?.type === "cancel_meeting" ? handler.handle(action, dryRun) : null;
          }
          default:
            return null;
        }
      },
      async turnRowCounts() {
        const counts: Record<string, number> = {};
        for (const [name, table] of Object.entries(TURN_TABLES)) {
          const [row] = await admin.select({ total: count() }).from(table);
          counts[name] = row?.total ?? 0;
        }
        return counts;
      },
      dispose: () => database.dispose(),
    };
  } catch (error) {
    await database.dispose();
    throw error;
  }
}
