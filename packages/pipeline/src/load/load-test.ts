import { randomUUID } from "node:crypto";

import { createOfflineModelClient } from "@repo/ai";
import {
  buildTestWebhookRequest,
  createTestChannelAdapter,
  type TestChannelTransport,
  type TestDelivery,
  testAccountIdFor,
  type TestWebhookBody,
} from "@repo/channel-test";
import type { ConversationId, SendResult } from "@repo/core";
import { createLogger, type LogRecord } from "@repo/core";
import {
  and,
  asc,
  type BusinessTenant,
  businesses,
  channelConnections,
  contactIdentities,
  conversations,
  conversationTurns,
  createDatabase,
  type Database,
  eq,
  messages,
  segments,
} from "@repo/db";
import { createTenantStorage, MemoryObjectStore } from "@repo/db/storage";
import { createTestDatabase, createTestKeyring } from "@repo/db/testing";
import { createLocalJobRunner } from "@repo/jobs";
import type { AppSettings } from "@repo/settings";
import { applySettingChanges } from "@repo/settings/server";

import { createAdapterRegistry } from "../adapters";
import { createPipeline } from "../pipeline";

/**
 * The load test (C18, `pnpm load:test`): many businesses receive bursts of customer messages
 * at the same time, through the real pipeline (webhook, ingest, debounce, turn lease, guards,
 * the real engine with the offline rule-based model, lead scoring, send) on local PostgreSQL
 * with the in-process job runner. It checks that:
 *
 * - debounce holds: every burst of quick messages gets exactly one reply turn, which deals
 *   with all of them, and no turn fails or is superseded;
 * - order holds: per conversation, the replies leave in the order they were stored, all sent;
 * - reply latency holds: from the last message of a burst to the first reply leaving, minus
 *   the configured wait, stays under a bound. The configured wait is the longer of the debounce
 *   and the reply wait setting: both count from the burst's last message;
 * - no limit trips for ordinary bursts with every `limits.*` setting at its default;
 * - one business at its daily reply cap: each conversation stopped by the cap gets the notice
 *   once (with the 911 sentence), and a message describing an emergency is still answered.
 *
 * What it does not measure: the Claude API's latency (the offline model answers at once),
 * Inngest's scheduling, Vercel's cold starts, or a hosted database. Its numbers describe this
 * machine; they are not production capacity.
 */

export interface LoadTestOptions {
  readonly businesses: number;
  readonly conversationsPerBusiness: number;
  /** Bursts per conversation; the next burst starts after the reply to the last one. */
  readonly bursts: number;
  readonly messagesPerBurst: number;
  /** Time between the messages of a burst. */
  readonly messageGapMs: number;
  /** Conversations start at random within this window. */
  readonly startSpreadMs: number;
  /** Fail when a reply leaves later than the configured wait plus this. */
  readonly maxOverheadMs: number;
  /** Null: the setting's default (`conversation.reply_wait_seconds.widget`, used by the test channel). */
  readonly replyWaitSeconds: number | null;
  /** Null: the production debounce of `pipeline-reply` (2 s). */
  readonly debouncePeriodMs: number | null;
  /** Runs the business-at-its-daily-cap scenario. */
  readonly cappedBusiness: boolean;
  /** Database connections of the pipeline. */
  readonly poolSize: number;
  readonly log: (line: string) => void;
}

export const DEFAULT_LOAD_TEST_OPTIONS: LoadTestOptions = {
  businesses: 50,
  conversationsPerBusiness: 3,
  bursts: 2,
  messagesPerBurst: 3,
  messageGapMs: 400,
  startSpreadMs: 5_000,
  maxOverheadMs: 30_000,
  replyWaitSeconds: null,
  debouncePeriodMs: null,
  cappedBusiness: true,
  poolSize: 20,
  log: () => undefined,
};

export interface Distribution {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

export interface LoadTestReport {
  readonly businesses: number;
  readonly conversations: number;
  readonly inboundMessages: number;
  readonly bursts: number;
  readonly replyTurns: number;
  readonly outboundMessages: number;
  readonly configuredWaitMs: number;
  /** Time for the webhook handler to store a message and hand its event over (ms). */
  readonly webhookMs: Distribution;
  /** From the last message of a burst to the first reply leaving (ms). */
  readonly replyLatencyMs: Distribution;
  /** The same minus the configured wait (ms). */
  readonly overheadMs: Distribution;
  readonly durationMs: number;
  readonly capped: {
    readonly answeredBeforeCap: number;
    readonly stoppedConversations: number;
    readonly noticesPerStoppedConversation: readonly number[];
    readonly emergencyAnswered: boolean;
  } | null;
  readonly failures: readonly string[];
}

const ALL_DAY = [{ open: "00:00", close: "23:59" }];
const SECRET = "load-test-secret-0123456789abcdef";
const DEBOUNCE_MS = 2_000;
const DEFAULT_WIDGET_WAIT_SECONDS = 4;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) return { count: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
  return {
    count: sorted.length,
    p50: Math.round(at(0.5)),
    p95: Math.round(at(0.95)),
    max: Math.round(sorted[sorted.length - 1]!),
  };
}

/** Keeps every delivery with the time it left (the in-memory transport keeps the last 1,000). */
class RecordingTransport implements TestChannelTransport {
  readonly deliveries: (TestDelivery & { readonly at: number })[] = [];
  private readonly byKey = new Map<string, string>();

  async deliver(
    delivery: Omit<TestDelivery, "externalMessageId" | "deliveredAt">,
  ): Promise<SendResult> {
    const deliveredAt = new Date().toISOString();
    const known = this.byKey.get(delivery.idempotencyKey);
    if (known !== undefined) return { ok: true, externalMessageId: known, sentAt: deliveredAt };
    const externalMessageId = `load-out-${randomUUID()}`;
    this.byKey.set(delivery.idempotencyKey, externalMessageId);
    this.deliveries.push({ ...delivery, externalMessageId, deliveredAt, at: Date.now() });
    return { ok: true, externalMessageId, sentAt: deliveredAt };
  }

  async signal(): Promise<void> {}

  async fetchMedia(): Promise<never> {
    throw new Error("The load test sends no media.");
  }

  firstAfter(conversationId: string, after: number): number | null {
    for (const delivery of this.deliveries) {
      if (delivery.conversationId === conversationId && delivery.at >= after) return delivery.at;
    }
    return null;
  }
}

interface LoadBusiness {
  readonly tenant: BusinessTenant;
  readonly accountId: string;
}

const CUSTOMER_LINES = [
  "Hi, my roof is leaking over the kitchen.",
  "It started after the storm on Sunday.",
  "Can someone come and look at it this week?",
  "I own the house, it's a single family home.",
  "The ZIP is 80214.",
  "Budget is maybe around $10,000 if it needs replacing.",
];

export async function runLoadTest(partial: Partial<LoadTestOptions> = {}): Promise<LoadTestReport> {
  const options = { ...DEFAULT_LOAD_TEST_OPTIONS, ...partial };
  const log = options.log;
  const failures: string[] = [];
  const started = Date.now();

  const t = await createTestDatabase();
  const db: Database = createDatabase({
    url: t.url,
    max: options.poolSize,
    keyring: createTestKeyring(),
    applicationName: "hsrb-load-test",
  });
  const errors: LogRecord[] = [];
  const logger = createLogger({
    level: "warn",
    sink: (record) => {
      if (record.level === "error") errors.push(record);
    },
  });
  const runner = createLocalJobRunner({
    logger,
    ...(options.debouncePeriodMs === null ? {} : { debouncePeriodMs: options.debouncePeriodMs }),
  });
  const transport = new RecordingTransport();
  const adapter = createTestChannelAdapter({ secret: SECRET, transport });
  const store = new MemoryObjectStore();
  const pipeline = createPipeline({
    db,
    adapters: createAdapterRegistry([adapter]),
    events: runner,
    logger,
    model: createOfflineModelClient(),
    storage: (tenant) => createTenantStorage(store, tenant),
  });
  runner.register(pipeline.jobs());

  const waitSeconds = options.replyWaitSeconds ?? DEFAULT_WIDGET_WAIT_SECONDS;
  // The debounce starts the run after the last message; the run then sleeps until the last
  // message's time plus the reply wait (`reply/claim.ts`). Both count from the same moment.
  const configuredWaitMs = Math.max(waitSeconds * 1000, options.debouncePeriodMs ?? DEBOUNCE_MS);
  const webhookMs: number[] = [];
  const latencies: number[] = [];

  async function deliver(business: LoadBusiness, visitor: string, text: string): Promise<number> {
    const body: TestWebhookBody = {
      accountId: business.accountId,
      events: [
        {
          type: "message",
          id: `load-${randomUUID()}`,
          from: { id: visitor, name: "Pat" },
          text,
          sentAt: new Date().toISOString(),
        },
      ],
    };
    const before = performance.now();
    const response = await pipeline.handleWebhook(
      "test",
      buildTestWebhookRequest({ secret: SECRET, body }),
    );
    webhookMs.push(performance.now() - before);
    if (response.status !== 200) failures.push(`A webhook answered ${response.status}.`);
    return Date.now();
  }

  /** The visitor's conversation (one per contact and connection on the test channel). */
  async function conversationOf(business: LoadBusiness, visitor: string): Promise<string> {
    const [row] = await t.admin
      .select({ id: conversations.id })
      .from(conversations)
      .innerJoin(contactIdentities, eq(contactIdentities.contactId, conversations.contactId))
      .where(
        and(
          eq(conversations.businessId, business.tenant.businessId),
          eq(contactIdentities.externalId, visitor),
        ),
      )
      .orderBy(asc(conversations.createdAt))
      .limit(1);
    if (row === undefined) throw new Error(`No conversation for ${visitor}.`);
    return row.id;
  }

  async function waitForReply(conversationId: string, after: number): Promise<number | null> {
    const deadline = Date.now() + configuredWaitMs + options.maxOverheadMs + 60_000;
    while (Date.now() < deadline) {
      const at = transport.firstAfter(conversationId, after);
      if (at !== null) return at;
      await sleep(100);
    }
    return null;
  }

  try {
    // One agency, one segment, the businesses with a test-channel connection each.
    const { id: agencyId } = await db.platform.createAgency({
      name: "Load test agency",
      slug: `load-${randomUUID().slice(0, 8)}`,
    });
    const [segment] = await t.admin
      .insert(segments)
      .values({ agencyId, slug: "roofing", name: "Roofing" })
      .returning({ id: segments.id });

    async function newBusiness(
      index: number,
      settings: Partial<AppSettings>,
    ): Promise<LoadBusiness> {
      const [row] = await t.admin
        .insert(businesses)
        .values({
          agencyId,
          segmentId: segment!.id,
          name: `Load Roofing ${index}`,
          slug: `load-roofing-${index}-${randomUUID().slice(0, 6)}`,
          status: "active",
        })
        .returning({ id: businesses.id });
      const businessId = row!.id;
      const accountId = testAccountIdFor(businessId);
      await t.admin.insert(channelConnections).values({
        agencyId,
        businessId,
        channel: "test",
        externalAccountId: accountId,
        status: "active",
      });
      const tenant = { agencyId, businessId };
      const values: Partial<AppSettings> = {
        // Open around the clock, so the result does not depend on the time of day.
        "hours.weekly": {
          monday: ALL_DAY,
          tuesday: ALL_DAY,
          wednesday: ALL_DAY,
          thursday: ALL_DAY,
          friday: ALL_DAY,
          saturday: ALL_DAY,
          sunday: ALL_DAY,
        },
        "hours.us_federal_holidays": false,
        ...(options.replyWaitSeconds === null
          ? {}
          : { "conversation.reply_wait_seconds.widget": options.replyWaitSeconds }),
        ...settings,
      };
      await db.forBusiness(tenant.businessId).run((ctx) =>
        applySettingChanges(ctx, {
          target: { scope: "business", ...tenant },
          changes: Object.entries(values).map(([key, value]) => ({ key, value: value as never })),
          actor: { type: "system", label: "load test" },
        }),
      );
      return { tenant, accountId };
    }

    const list: LoadBusiness[] = [];
    for (let index = 0; index < options.businesses; index += 1) {
      list.push(await newBusiness(index + 1, {}));
    }
    log(
      `${list.length} businesses, ${options.conversationsPerBusiness} conversations each, ` +
        `${options.bursts} bursts of ${options.messagesPerBurst} messages per conversation.`,
    );

    // Phase 1: every conversation at once, each customer waiting for the answer to a burst
    // before writing the next one.
    const conversationIds = new Map<string, LoadBusiness>();
    let burstsDone = 0;
    const runConversation = async (business: LoadBusiness, visitor: string) => {
      await sleep(Math.random() * options.startSpreadMs);
      let conversationId: string | null = null;
      let line = 0;
      for (let burst = 0; burst < options.bursts; burst += 1) {
        let last = 0;
        for (let index = 0; index < options.messagesPerBurst; index += 1) {
          if (index > 0) await sleep(options.messageGapMs);
          last = await deliver(business, visitor, CUSTOMER_LINES[line % CUSTOMER_LINES.length]!);
          line += 1;
        }
        conversationId ??= await conversationOf(business, visitor);
        conversationIds.set(conversationId, business);
        const replied = await waitForReply(conversationId, last);
        if (replied === null) {
          failures.push(`No reply to burst ${burst + 1} of conversation ${conversationId}.`);
          return;
        }
        latencies.push(replied - last);
        burstsDone += 1;
        await sleep(500 + Math.random() * 1_500);
      }
    };
    const progress = setInterval(() => {
      log(`  ${burstsDone} bursts answered so far…`);
    }, 10_000);
    try {
      await Promise.all(
        list.flatMap((business) =>
          Array.from({ length: options.conversationsPerBusiness }, (_, index) =>
            runConversation(business, `visitor-${index + 1}`),
          ),
        ),
      );
      await runner.idle();
    } finally {
      clearInterval(progress);
    }

    // Debounce, ordering and limits, per conversation, from the stored rows.
    let replyTurns = 0;
    let outboundMessages = 0;
    for (const [conversationId, business] of conversationIds) {
      const turns = await t.admin
        .select({ status: conversationTurns.status, skipReason: conversationTurns.skipReason })
        .from(conversationTurns)
        .where(eq(conversationTurns.conversationId, conversationId as ConversationId));
      const replied = turns.filter((turn) => turn.status === "replied").length;
      replyTurns += replied;
      if (replied !== options.bursts) {
        failures.push(
          `Conversation ${conversationId}: ${replied} reply turns for ${options.bursts} bursts (${turns
            .map((turn) => `${turn.status}${turn.skipReason === null ? "" : `:${turn.skipReason}`}`)
            .join(", ")}).`,
        );
      }
      const [conversation] = await t.admin
        .select({ handled: conversations.handledThroughSeq })
        .from(conversations)
        .where(eq(conversations.id, conversationId as ConversationId));
      const rows = await t.admin
        .select({
          id: messages.id,
          direction: messages.direction,
          sequence: messages.sequence,
          status: messages.status,
          purpose: messages.payload,
        })
        .from(messages)
        .where(eq(messages.conversationId, conversationId as ConversationId))
        .orderBy(asc(messages.sequence));
      const inbound = rows.filter((row) => row.direction === "inbound");
      if (inbound.some((row) => row.sequence > (conversation?.handled ?? 0))) {
        failures.push(`Conversation ${conversationId}: a customer message was never dealt with.`);
      }
      const outbound = rows.filter((row) => row.direction === "outbound");
      outboundMessages += outbound.length;
      if (outbound.some((row) => row.status !== "sent")) {
        failures.push(`Conversation ${conversationId}: a reply was not sent.`);
      }
      if (outbound.some((row) => row.purpose["purpose"] === "limit_notice")) {
        failures.push(
          `Business ${business.tenant.businessId}: a limit stopped the bot at default limits.`,
        );
      }
      // The order the replies left in is the order they were stored in.
      const sequenceOf = new Map(outbound.map((row) => [row.id as string, row.sequence]));
      const sentOrder = transport.deliveries
        .filter((delivery) => delivery.conversationId === conversationId)
        .map((delivery) => sequenceOf.get(delivery.idempotencyKey.split(":")[0]!) ?? -1);
      for (let index = 1; index < sentOrder.length; index += 1) {
        if (sentOrder[index]! < sentOrder[index - 1]!) {
          failures.push(`Conversation ${conversationId}: replies left out of order.`);
          break;
        }
      }
    }
    const overhead = latencies.map((value) => value - configuredWaitMs);
    const slow = overhead.filter((value) => value > options.maxOverheadMs).length;
    if (slow > 0) {
      failures.push(
        `${slow} replies left more than ${options.maxOverheadMs / 1000} s after the configured wait.`,
      );
    }

    // Phase 2: one business at its daily reply cap.
    let capped: LoadTestReport["capped"] = null;
    if (options.cappedBusiness) {
      capped = await runCappedBusiness();
    }

    // The cap logs an error on purpose (it reaches Sentry): the business stopped.
    const unexpected = errors.filter((record) => record.msg !== "limits.cap_reached");
    if (unexpected.length > 0) {
      const names = [...new Set(unexpected.map((record) => record.msg))].slice(0, 5).join(", ");
      failures.push(`${unexpected.length} error logs (${names}).`);
    }

    return {
      businesses: list.length,
      conversations: conversationIds.size,
      inboundMessages: webhookMs.length,
      bursts: latencies.length,
      replyTurns,
      outboundMessages,
      configuredWaitMs,
      webhookMs: distribution(webhookMs),
      replyLatencyMs: distribution(latencies),
      overheadMs: distribution(overhead),
      durationMs: Date.now() - started,
      capped,
      failures,
    };

    async function runCappedBusiness(): Promise<NonNullable<LoadTestReport["capped"]>> {
      // The smallest cap the setting allows. Conversations are answered one after another
      // until the cap stops one; three more customers then write twice each; then a customer
      // describes a gas leak.
      const business = await newBusiness(0, { "limits.business_replies_per_day": 10 });
      const skippedByCap = async (conversationId: string) =>
        (
          await t.admin
            .select({ skipReason: conversationTurns.skipReason })
            .from(conversationTurns)
            .where(eq(conversationTurns.conversationId, conversationId as ConversationId))
        ).some((turn) => turn.skipReason === "limits:business_replies_per_day");
      const noticesOf = async (conversationId: string) =>
        (
          await t.admin
            .select({ payload: messages.payload, text: messages.text })
            .from(messages)
            .where(eq(messages.conversationId, conversationId as ConversationId))
        ).filter((row) => row.payload["purpose"] === "limit_notice");

      let answered = 0;
      const stopped: string[] = [];
      for (let index = 0; index < 20 && stopped.length === 0; index += 1) {
        const visitor = `capped-${index}`;
        await deliver(business, visitor, "Hi, I would like a quote for new gutters.");
        await runner.idle();
        const conversationId = await conversationOf(business, visitor);
        if (await skippedByCap(conversationId)) stopped.push(conversationId);
        else answered += 1;
      }
      if (stopped.length === 0) {
        failures.push("The daily reply cap never stopped a turn.");
      }
      for (let index = 0; index < 3; index += 1) {
        const visitor = `capped-after-${index}`;
        await deliver(business, visitor, "Hello, is anyone there?");
        await runner.idle();
        await deliver(business, visitor, "Hello?? I still need that quote.");
        await runner.idle();
        stopped.push(await conversationOf(business, visitor));
      }
      const notices: number[] = [];
      for (const conversationId of stopped) {
        const rows = await noticesOf(conversationId);
        notices.push(rows.length);
        if (rows.length !== 1) {
          failures.push(
            `Capped conversation ${conversationId} got ${rows.length} notices instead of one.`,
          );
        } else if (!(rows[0]!.text ?? "").includes("911")) {
          failures.push(`The notice of conversation ${conversationId} does not mention 911.`);
        }
        if (!(await skippedByCap(conversationId))) {
          failures.push(`Capped conversation ${conversationId} was not stopped by the cap.`);
        }
      }
      await deliver(
        business,
        "capped-emergency",
        "I smell gas in the kitchen, it's really strong.",
      );
      await runner.idle();
      const emergency = await conversationOf(business, "capped-emergency");
      const turns = await t.admin
        .select({ status: conversationTurns.status })
        .from(conversationTurns)
        .where(eq(conversationTurns.conversationId, emergency as ConversationId));
      const emergencyAnswered = turns.some((turn) => turn.status === "replied");
      if (!emergencyAnswered) {
        failures.push("A customer describing a gas leak at the capped business got no answer.");
      }
      log(
        `Capped business: ${answered} conversations answered before the cap, ` +
          `${stopped.length} stopped, emergency ${emergencyAnswered ? "answered" : "NOT answered"}.`,
      );
      return {
        answeredBeforeCap: answered,
        stoppedConversations: stopped.length,
        noticesPerStoppedConversation: notices,
        emergencyAnswered,
      };
    }
  } finally {
    runner.stop();
    await runner.idle();
    await db.close();
    await t.dispose();
  }
}
