import { ensureWidgetConnection } from "@repo/channel-widget/server";
import {
  type AgencyId,
  type BusinessId,
  type Logger,
  logger as rootLogger,
  type SegmentId,
} from "@repo/core";
import {
  and,
  type AuditActor,
  businesses,
  businessSlug,
  type Database,
  eq,
  recordSystemAudit,
  segments,
} from "@repo/db";
import type { EventSender } from "@repo/jobs";
import {
  assignSegment,
  getActivePlaybook,
  importApiRecords,
  savePlaybookVersion,
  starterPlaybook,
} from "@repo/knowledge";
import type { SettingChange } from "@repo/settings";
import { applySettingChanges } from "@repo/settings/server";

import { SAMPLE_BUSINESSES, type SampleBusiness } from "./sample-businesses";

/*
 * `pnpm demo:setup`: stores the sample businesses of the public demo site in one agency, each
 * the way the admin panel's onboarding would leave it (a trade with a playbook, facts, the
 * website chat) plus the settings that make it a demo: the public demo page, a chat that opens
 * by itself, quick replies and low spend caps. Running it again updates what it wrote and
 * leaves alone what a person changed since: facts edited by hand and settings it does not set.
 */

const ACTOR = { type: "system", label: "demo:setup" } as const satisfies AuditActor;

const refOf = (sample: SampleBusiness) => `demo:${sample.ref}`;

export interface ProvisionDemoOptions {
  readonly db: Database;
  readonly agencyId: AgencyId;
  /** Default: all of them. */
  readonly samples?: readonly SampleBusiness[];
  readonly logger?: Logger;
  readonly now?: () => Date;
}

export interface ProvisionedBusiness {
  readonly businessId: BusinessId;
  readonly name: string;
  readonly slug: string;
  readonly segment: string;
  readonly created: boolean;
  /** "stored": the built-in starter document was saved now; "kept": the trade already had one. */
  readonly playbook: "stored" | "kept";
  readonly facts: { readonly created: number; readonly updated: number; readonly kept: number };
  readonly widgetKey: string;
}

/** No job is ever queued here: every trade has its playbook before a business is put in it. */
const noEvents: EventSender = {
  async send() {
    throw new Error("demo:setup queues no jobs.");
  },
};

type Interval = { readonly open: string; readonly close: string };

function weeklyHours(sample: SampleBusiness): Record<string, Interval[]> {
  const weekday = [{ open: sample.hours.weekdays[0], close: sample.hours.weekdays[1] }];
  const saturday =
    sample.hours.saturday === null
      ? []
      : [{ open: sample.hours.saturday[0], close: sample.hours.saturday[1] }];
  return {
    monday: weekday,
    tuesday: weekday,
    wednesday: weekday,
    thursday: weekday,
    friday: weekday,
    saturday,
    sunday: [],
  };
}

/** The business-scope settings of a sample business. Exported for the test that validates them. */
export function demoSettings(sample: SampleBusiness): SettingChange[] {
  return [
    // What makes it a demo.
    { key: "channels.widget.demo_page", value: true },
    { key: "channels.widget.auto_open_seconds", value: 2 },
    // The assistant answers around the clock; "the office is closed" would read as "nobody home".
    { key: "channels.widget.show_hours_notice", value: false },
    { key: "channels.widget.primary_color", value: sample.color },
    { key: "channels.widget.teaser", value: sample.teaser },
    { key: "channels.widget.subtitle", value: "{{bot_name}} usually replies in under a minute" },
    { key: "conversation.reply_wait_seconds.widget", value: 1 },
    // Nobody is waiting behind a demo: no nudges to visitors who stop writing.
    { key: "follow_up.enabled", value: false },
    // A public page anyone can write to: keep what one visitor and one day can cost small.
    { key: "limits.contact_daily_spend_usd", value: 2 },
    { key: "limits.business_daily_spend_usd", value: 20 },
    { key: "limits.business_replies_per_day", value: 600 },
    // The business itself.
    { key: "persona.bot_name", value: sample.botName },
    // The greeting every visitor sees first already says "AI assistant": the first reply
    // does not have to introduce itself a second time.
    { key: "voice.opening_message.widget", value: sample.opening },
    { key: "persona.ai_disclosure", value: "when_asked" },
    { key: "hours.weekly", value: weeklyHours(sample) },
    // Emergencies as the business's facts describe them: an on-call crew or office hours, and
    // its own (fictional) number as the line to call.
    {
      key: "emergency.service_level",
      value: sample.onCall ? "around_the_clock" : "business_hours",
    },
    { key: "emergency.customer_instruction", value: "both" },
    { key: "emergency.phone", value: `+1${sample.profile.phone.replaceAll(/\D/g, "")}` },
    // The sample businesses list the towns they serve, so the assistant asks for the town.
    { key: "qualification.service_area.ask_for", value: "city" },
    { key: "qualification.service_area.cities", value: [...sample.cities] },
    { key: "qualification.service_area.states", value: [sample.profile.state] },
  ];
}

async function ensureSegmentPlaybook(
  db: Database,
  agencyId: AgencyId,
  sample: SampleBusiness,
): Promise<{ readonly segmentId: SegmentId; readonly playbook: "stored" | "kept" }> {
  return db.forAgency(agencyId).run(async (ctx) => {
    const bySlug = and(eq(segments.agencyId, agencyId), eq(segments.slug, sample.segment.slug));
    await ctx.tx
      .insert(segments)
      .values({ agencyId, slug: sample.segment.slug, name: sample.segment.name })
      .onConflictDoNothing({ target: [segments.agencyId, segments.slug] });
    const [segment] = await ctx.tx.select({ id: segments.id }).from(segments).where(bySlug);
    if (segment === undefined) throw new Error(`The segment ${sample.segment.slug} is missing.`);
    if ((await getActivePlaybook(ctx, segment.id)) !== null) {
      return { segmentId: segment.id, playbook: "kept" as const };
    }
    // The engine's built-in document for the trade: complete and safe (no prices, no claims),
    // but not researched. "Generate again" on the playbook's page replaces it with one the
    // model researches on the web.
    await savePlaybookVersion(ctx, {
      segmentId: segment.id,
      document: starterPlaybook(sample.segment.slug).document,
      origin: "starter",
      changeNote:
        "Built-in starter playbook, stored by demo:setup. Generate it again for a researched one.",
      actor: ACTOR,
    });
    return { segmentId: segment.id, playbook: "stored" as const };
  });
}

async function ensureBusiness(
  db: Database,
  agencyId: AgencyId,
  sample: SampleBusiness,
): Promise<{ readonly id: BusinessId; readonly slug: string; readonly created: boolean }> {
  return db.forAgency(agencyId).run(async (ctx) => {
    const [existing] = await ctx.tx
      .select({ id: businesses.id, slug: businesses.slug })
      .from(businesses)
      .where(and(eq(businesses.agencyId, agencyId), eq(businesses.externalRef, refOf(sample))))
      .limit(1);
    if (existing !== undefined) return { ...existing, created: false };

    const taken = new Set(
      (
        await ctx.tx
          .select({ slug: businesses.slug })
          .from(businesses)
          .where(eq(businesses.agencyId, agencyId))
      ).map((row) => row.slug),
    );
    const base = businessSlug(sample.profile.name);
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base.slice(0, 55)}-${n}`;
    const [created] = await ctx.tx
      .insert(businesses)
      .values({
        agencyId,
        slug,
        status: "onboarding",
        externalRef: refOf(sample),
        ...sample.profile,
      })
      .returning({ id: businesses.id });
    if (created === undefined) throw new Error("The business insert returned no row.");
    await recordSystemAudit(ctx, ACTOR, {
      action: "business.create",
      targetType: "business",
      targetId: created.id,
      summary: "Sample business created for the public demo site",
    });
    return { id: created.id, slug, created: true };
  });
}

/** Stores (or refreshes) the sample businesses in the agency. Safe to run again. */
export async function provisionDemo(options: ProvisionDemoOptions): Promise<ProvisionedBusiness[]> {
  const { db, agencyId } = options;
  const logger = (options.logger ?? rootLogger).child({ component: "demo-setup" });
  const now = options.now ?? (() => new Date());
  const results: ProvisionedBusiness[] = [];

  for (const sample of options.samples ?? SAMPLE_BUSINESSES) {
    const { segmentId, playbook } = await ensureSegmentPlaybook(db, agencyId, sample);
    const business = await ensureBusiness(db, agencyId, sample);
    // The onboarding path: the trade's settings preset on first use, the playbook reused.
    await assignSegment(
      { db, events: noEvents, logger },
      { agencyId, businessId: business.id, segment: { id: segmentId }, requestedBy: null },
    );

    // Facts arrive the way the agency's lead-generation data does: through the import.
    const imported = await db.forAgency(agencyId).run((ctx) =>
      importApiRecords(ctx, {
        agencyId,
        businessId: business.id,
        body: {
          mode: "merge",
          profileMode: "fill_empty",
          businesses: [{ id: business.id, facts: sample.facts }],
        },
        actor: ACTOR,
        now: now(),
      }),
    );
    if (!imported.ok || imported.result.problems.length > 0) {
      const problems = imported.ok ? imported.result.problems : imported.problems;
      throw new Error(
        `The facts of ${sample.profile.name} were refused: ${problems
          .map((problem) => problem.message)
          .join(" ")}`,
      );
    }

    const widgetKey = await db.forBusiness(business.id, { agencyId }).run(async (ctx) => {
      const connection = await ensureWidgetConnection(ctx, { actor: ACTOR, now: now() });
      await applySettingChanges(ctx, {
        target: { scope: "business", agencyId, businessId: business.id },
        changes: demoSettings(sample),
        note: "Sample business of the public demo site",
        actor: ACTOR,
      });
      await ctx.tx
        .update(businesses)
        .set({ status: "active", updatedAt: now() })
        .where(and(eq(businesses.id, business.id), eq(businesses.status, "onboarding")));
      return connection.publicKey;
    });

    const { stats } = imported.result;
    results.push({
      businessId: business.id,
      name: sample.profile.name,
      slug: business.slug,
      segment: sample.segment.name,
      created: business.created,
      playbook,
      facts: {
        created: stats.factsCreated,
        updated: stats.factsUpdated,
        kept: stats.factsKept + stats.factsUnchanged,
      },
      widgetKey,
    });
    logger.info("demo.business_ready", { businessId: business.id, created: business.created });
  }
  return results;
}
