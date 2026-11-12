import { randomUUID } from "node:crypto";

import {
  type AgencyId,
  type BusinessId,
  type ContactId,
  type ConversationId,
  createLogger,
  type LeadId,
  type TraceId,
  type UserId,
} from "@repo/core";
import {
  businesses,
  channelConnections,
  contacts,
  conversations,
  leadFields,
  leadReports,
  leads,
  messages,
  segments,
  sql,
  eq,
} from "@repo/db";
import type { TestDatabase } from "@repo/db/testing";
import type { AnyJobEvent, EventJobDefinition, JobDefinition, StepTools } from "@repo/jobs";
import type { EventName, EventPayload } from "@repo/core";
import type { AppSettings } from "@repo/settings";
import { applySettingChanges } from "@repo/settings/server";

import type { HandoffDeps, OutboundMessages } from "./deps";
import { createRecordingTransports } from "./testing";

/*
 * Test support for the database tests of this package (not exported): a business with one
 * conversation and its lead, settings writers, a controllable clock, and a driver that runs a
 * job's handler with step tools whose sleeps move the clock instead of waiting.
 */

export const quiet = createLogger({ level: "error", sink: () => {} });
export const TRACE = "0e000000-0000-4000-8000-0000000000d1" as TraceId;

export interface Fixture {
  readonly tenant: { readonly agencyId: AgencyId; readonly businessId: BusinessId };
  readonly conversationId: ConversationId;
  readonly contactId: ContactId;
  readonly leadId: LeadId;
  readonly connectionId: string;
}

export async function createFixture(
  t: TestDatabase,
  options: {
    readonly channel?: "test" | "whatsapp" | "email" | "messenger";
    readonly phone?: string | null;
    readonly leadStatus?: string;
    readonly routing?: "book_meeting" | "contact_later" | null;
    readonly lastInboundAt?: Date;
  } = {},
): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const { id: agencyId } = await t.db.platform.createAgency({
    name: `A ${suffix}`,
    slug: `a-${suffix}`,
  });
  const [segment] = await t.admin
    .insert(segments)
    .values({ agencyId, slug: "plumbing", name: "Plumbing" })
    .returning({ id: segments.id });
  const [business] = await t.admin
    .insert(businesses)
    .values({
      agencyId,
      segmentId: segment!.id,
      name: "Lone Star Plumbing",
      slug: `lone-star-${suffix}`,
      status: "active",
      timezone: "America/Chicago",
    })
    .returning({ id: businesses.id });
  const tenant = { agencyId, businessId: business!.id };
  const channel = options.channel ?? "test";
  const [connection] = await t.admin
    .insert(channelConnections)
    .values({ ...tenant, channel, externalAccountId: `acct-${suffix}`, status: "active" })
    .returning({ id: channelConnections.id });
  const [contact] = await t.admin
    .insert(contacts)
    .values({
      ...tenant,
      displayName: "Pat Lee",
      phone: options.phone === undefined ? "+15125550199" : options.phone,
      email: "pat.lee@example.com",
    })
    .returning({ id: contacts.id });
  const [conversation] = await t.admin
    .insert(conversations)
    .values({
      ...tenant,
      contactId: contact!.id,
      channelConnectionId: connection!.id,
      channel,
      lastInboundAt: options.lastInboundAt ?? null,
    })
    .returning({ id: conversations.id });
  const [lead] = await t.admin
    .insert(leads)
    .values({
      ...tenant,
      contactId: contact!.id,
      conversationId: conversation!.id,
      status: (options.leadStatus ?? "qualifying") as "qualifying",
      score: 84,
      band: "hot",
      routingOutcome: options.routing === undefined ? null : options.routing,
    })
    .returning({ id: leads.id });
  await t.admin.insert(leadFields).values({
    ...tenant,
    leadId: lead!.id,
    key: "service_type",
    value: "water heater replacement",
    confidence: 1,
    evidence: null,
  });
  await t.admin.insert(leadReports).values({
    ...tenant,
    leadId: lead!.id,
    version: 1,
    summary: "Homeowner in 78704 needs a water heater replaced this week.",
    markdown: "## Who\nPat Lee\n## Job\nWater heater, see https://evil.example",
    sections: {},
    score: 84,
    band: "hot",
  });
  return {
    tenant,
    conversationId: conversation!.id,
    contactId: contact!.id,
    leadId: lead!.id,
    connectionId: connection!.id,
  };
}

export async function setBusinessSettings(
  t: TestDatabase,
  tenant: Fixture["tenant"],
  values: Partial<AppSettings>,
): Promise<void> {
  await t.db.forBusiness(tenant.businessId, { agencyId: tenant.agencyId }).run((ctx) =>
    applySettingChanges(ctx, {
      target: { scope: "business", ...tenant },
      changes: Object.entries(values).map(([key, value]) => ({ key, value: value as never })),
      actor: { type: "system", label: "handoff tests" },
    }),
  );
}

export async function setAgencySettings(
  t: TestDatabase,
  agencyId: AgencyId,
  values: Partial<AppSettings>,
): Promise<void> {
  await t.db.forAgency(agencyId).run((ctx) =>
    applySettingChanges(ctx, {
      target: { scope: "global", agencyId },
      changes: Object.entries(values).map(([key, value]) => ({ key, value: value as never })),
      actor: { type: "system", label: "handoff tests" },
    }),
  );
}

/** Stores a customer message (the pipeline's shape) and moves the conversation's counter. */
export async function addInbound(
  t: TestDatabase,
  f: Fixture,
  text: string,
  at: Date,
): Promise<string> {
  const [counter] = await t.admin
    .update(conversations)
    .set({
      messageSeq: sql`${conversations.messageSeq} + 1`,
      lastInboundAt: at,
    })
    .where(eq(conversations.id, f.conversationId))
    .returning({ seq: conversations.messageSeq });
  const [row] = await t.admin
    .insert(messages)
    .values({
      ...f.tenant,
      conversationId: f.conversationId,
      channelConnectionId: f.connectionId as never,
      direction: "inbound",
      author: "customer",
      kind: "text",
      text,
      externalMessageId: `in-${randomUUID()}`,
      sequence: counter!.seq,
      status: "received",
      sentAt: at,
    })
    .returning({ id: messages.id });
  return row!.id;
}

/** A person who can be named on locks, messages and acknowledgements. */
export async function createUser(t: TestDatabase): Promise<UserId> {
  const user = await t.db.localAuth.upsertUser({ email: `staff-${randomUUID()}@handoff.test` });
  return user.id;
}

/** A clock the tests move; jobs read it through `deps.clock`. */
export class TestClock {
  constructor(public current: Date) {}
  readonly now = (): Date => new Date(this.current.getTime());
  set(at: Date | string): void {
    this.current = new Date(at);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export interface Sleep {
  readonly id: string;
  readonly until: string;
}

/**
 * Runs a job's handler once: steps run at once (results through JSON, like the runners), a
 * sleep moves the clock to its end (never backwards) after `beforeWake` had its say.
 */
export async function drive<TName extends EventName>(
  job: JobDefinition,
  data: EventPayload<TName>,
  clock: TestClock,
  options: {
    readonly beforeWake?: (sleep: Sleep) => Promise<void> | void;
    readonly eventId?: string;
    readonly memo?: Map<string, unknown>;
  } = {},
): Promise<{ readonly result: unknown; readonly sleeps: Sleep[]; readonly steps: string[] }> {
  const sleeps: Sleep[] = [];
  const steps: string[] = [];
  const memo = options.memo ?? new Map<string, unknown>();
  const step: StepTools = {
    async run(id, fn) {
      steps.push(id);
      if (memo.has(id)) return JSON.parse(JSON.stringify(memo.get(id))) as never;
      const value = (await fn()) ?? null;
      memo.set(id, value);
      return JSON.parse(JSON.stringify(value)) as never;
    },
    async sleep(id, ms) {
      const until = new Date(clock.now().getTime() + ms).toISOString();
      sleeps.push({ id, until });
      await options.beforeWake?.({ id, until });
      if (Date.parse(until) > clock.now().getTime()) clock.set(until);
    },
    async sleepUntil(id, until) {
      sleeps.push({ id, until: until.toISOString() });
      await options.beforeWake?.({ id, until: until.toISOString() });
      if (until.getTime() > clock.now().getTime()) clock.set(until);
    },
  };
  const definition = job as EventJobDefinition<TName>;
  const result = await definition.handler({
    event: { name: "event", id: options.eventId ?? randomUUID(), data },
    step,
    runId: randomUUID(),
    attempt: 0,
    logger: quiet,
  });
  return { result, sleeps, steps };
}

/** The deps of the package with recording transports, a recording event sender and outbound. */
export function testDeps(
  t: TestDatabase,
  clock: TestClock,
  transports = createRecordingTransports(),
) {
  const events: AnyJobEvent[] = [];
  const queued: { conversationId: string; text: string; purpose?: string; author: string }[] = [];
  const outbound: OutboundMessages = {
    async enqueueBot(_ctx, input) {
      queued.push({ ...input, author: "bot" });
      return {
        messageId: randomUUID(),
        events: [
          {
            name: "message.send_requested",
            id: `msg-send-${queued.length}`,
            data: {} as never,
          },
        ],
      };
    },
    async enqueueHuman(_ctx, input) {
      queued.push({ ...input, author: "human_agent" });
      return { messageId: randomUUID(), events: [] };
    },
  };
  const deps: HandoffDeps = {
    db: t.db,
    logger: quiet,
    clock: clock.now,
    events: {
      async send(list) {
        events.push(...list);
      },
    },
    outbound,
    appUrl: "https://app.example",
    transports,
  };
  return { deps, events, queued, transports };
}
