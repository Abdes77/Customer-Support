import { randomUUID } from "node:crypto";

import {
  createTestChannelAdapter,
  MemoryTestTransport,
  type TestChannelAdapter,
  testAccountIdFor,
  type TestWebhookBody,
  type TestWebhookEvent,
  buildTestWebhookRequest,
} from "@repo/channel-test";
import {
  type ChannelAdapter,
  type ConversationEngine,
  createLogger,
  type EngineTurnInput,
  type EngineTurnResult,
  type LogRecord,
  type ReplyDraft,
} from "@repo/core";
import {
  asc,
  type BusinessTenant,
  businesses,
  channelConnections,
  conversations,
  eq,
  messages,
  segments,
} from "@repo/db";
import { createTenantStorage, MemoryObjectStore } from "@repo/db/storage";
import { createTestDatabase, type TestDatabase } from "@repo/db/testing";
import {
  type AnyJobEvent,
  createLocalJobRunner,
  type EventSender,
  type JobEvent,
  type LocalJobRunner,
} from "@repo/jobs";
import type { AppSettings } from "@repo/settings";
import { applySettingChanges } from "@repo/settings/server";

import { createAdapterRegistry } from "../adapters";
import type { PipelineDeps, PipelineOptions } from "../deps";
import { createEchoEngine } from "../echo-engine";
import { createPipeline, type Pipeline } from "../pipeline";

export const TEST_SECRET = "pipeline-test-secret-0123456789";

/** An EventSender in front of the runner that records what goes out and can fail on demand. */
export class SpySender implements EventSender {
  readonly sent: AnyJobEvent[] = [];
  failures = 0;
  constructor(private readonly inner: EventSender) {}
  async send(events: readonly AnyJobEvent[]): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("Event delivery failed (test)");
    }
    this.sent.push(...events);
    await this.inner.send(events);
  }
  named<TName extends AnyJobEvent["name"]>(name: TName): JobEvent<TName>[] {
    return this.sent.filter((event) => event.name === name) as unknown as JobEvent<TName>[];
  }
}

export interface TestTenant {
  readonly tenant: BusinessTenant;
  readonly connectionId: string;
  readonly accountId: string;
}

export interface Harness {
  readonly t: TestDatabase;
  readonly pipeline: Pipeline;
  readonly runner: LocalJobRunner;
  readonly events: SpySender;
  readonly transport: MemoryTestTransport;
  readonly adapter: TestChannelAdapter;
  readonly logs: LogRecord[];
  /** The engine every turn uses; tests replace `engine.respond`. */
  readonly engine: { respond: ConversationEngine["respond"] };
  newTenant(settings?: Partial<AppSettings>): Promise<TestTenant>;
  setSettings(tenant: BusinessTenant, values: Partial<AppSettings>): Promise<void>;
  /** Signs and delivers a test-channel webhook through `handleWebhook`. */
  deliver(
    tenant: TestTenant,
    events: TestWebhookEvent[],
    options?: { secret?: string },
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  /** Waits until no job is running or waiting. */
  idle(): Promise<void>;
  messagesOf(tenant: TestTenant): Promise<(typeof messages.$inferSelect)[]>;
  conversationsOf(tenant: TestTenant): Promise<(typeof conversations.$inferSelect)[]>;
  dispose(): Promise<void>;
}

export function message(
  text: string | null,
  options: { id?: string; from?: string; attachments?: unknown[] } = {},
): TestWebhookEvent {
  return {
    type: "message",
    id: options.id ?? `m-${randomUUID()}`,
    from: { id: options.from ?? "visitor-1", name: "Pat" },
    text,
    sentAt: new Date().toISOString(),
    ...(options.attachments === undefined ? {} : { attachments: options.attachments as never }),
  };
}

export function reply(text: string, extra: Partial<EngineTurnResult> = {}): EngineTurnResult {
  return result([{ kind: "text", text }], extra);
}

export function result(
  drafts: ReplyDraft[],
  extra: Partial<EngineTurnResult> = {},
): EngineTurnResult {
  return {
    outcome: drafts.length > 0 ? "replied" : "no_reply",
    replies: drafts,
    actions: [],
    promptVersion: "test-engine",
    settingsVersion: "test",
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    ...extra,
  };
}

/** The pending customer texts of a turn, joined: what most test engines echo. */
export function pendingTexts(input: EngineTurnInput): string {
  return input.pending.map((turn) => turn.text ?? "").join(" + ");
}

const FAST_OPTIONS: Partial<PipelineOptions> = {
  leaseWaitsMs: [20, 40, 80, 160],
  orderWaitsMs: [20, 40, 80, 160, 320, 640, 1280, 2000, 4000],
  replyRetries: 2,
  sendRetries: 2,
};

export async function createHarness(
  overrides: Partial<Omit<PipelineDeps, "db" | "adapters" | "events" | "engine">> & {
    /** False: events are only recorded, no job runs (tests that drive the jobs themselves). */
    readonly runJobs?: boolean;
    /** Changes what the pipeline sees of the test adapter (capabilities, send behaviour). */
    readonly wrapAdapter?: (adapter: TestChannelAdapter) => ChannelAdapter;
  } = {},
): Promise<Harness> {
  const t = await createTestDatabase();
  const logs: LogRecord[] = [];
  const logger = createLogger({ level: "debug", sink: (record) => logs.push(record) });
  const runner = createLocalJobRunner({ logger, retryDelayMs: () => 10, debouncePeriodMs: 150 });
  const events = new SpySender(overrides.runJobs === false ? { send: async () => {} } : runner);
  const transport = new MemoryTestTransport();
  const adapter = createTestChannelAdapter({ secret: TEST_SECRET, transport });
  const echo = createEchoEngine();
  const engine = { respond: echo.respond.bind(echo) };
  const store = new MemoryObjectStore();
  const { runJobs: _runJobs, wrapAdapter, ...deps } = overrides;
  const pipeline = createPipeline({
    db: t.db,
    adapters: createAdapterRegistry([wrapAdapter === undefined ? adapter : wrapAdapter(adapter)]),
    engine: { respond: (input, ports) => engine.respond(input, ports) },
    events,
    logger,
    storage: (tenant) => createTenantStorage(store, tenant),
    ...deps,
    options: { ...FAST_OPTIONS, ...deps.options },
  });
  runner.register(pipeline.jobs());

  async function setSettings(tenant: BusinessTenant, values: Partial<AppSettings>) {
    await t.db.forBusiness(tenant.businessId).run((ctx) =>
      applySettingChanges(ctx, {
        target: { scope: "business", ...tenant },
        changes: Object.entries(values).map(([key, value]) => ({ key, value: value as never })),
        actor: { type: "system", label: "pipeline tests" },
      }),
    );
  }

  return {
    t,
    pipeline,
    runner,
    events,
    transport,
    adapter,
    logs,
    engine,
    setSettings,

    async newTenant(settings = {}) {
      const suffix = randomUUID().slice(0, 8);
      const { id: agencyId } = await t.db.platform.createAgency({
        name: `Agency ${suffix}`,
        slug: `agency-${suffix}`,
      });
      const [segment] = await t.admin
        .insert(segments)
        .values({ agencyId, slug: "roofing", name: "Roofing" })
        .returning({ id: segments.id });
      const [business] = await t.admin
        .insert(businesses)
        .values({
          agencyId,
          segmentId: segment!.id,
          name: `Summit Roofing ${suffix}`,
          slug: `summit-${suffix}`,
          status: "active",
        })
        .returning({ id: businesses.id });
      const businessId = business!.id;
      const accountId = testAccountIdFor(businessId);
      const [connection] = await t.admin
        .insert(channelConnections)
        .values({
          agencyId,
          businessId,
          channel: "test",
          externalAccountId: accountId,
          status: "active",
        })
        .returning({ id: channelConnections.id });
      const tenant = { agencyId, businessId };
      // Tests answer at once unless they ask for a wait (the test channel uses the website
      // chat's settings).
      await setSettings(tenant, { "conversation.reply_wait_seconds.widget": 0, ...settings });
      return { tenant, connectionId: connection!.id, accountId };
    },

    async deliver(tenant, list, options = {}) {
      const body: TestWebhookBody = { accountId: tenant.accountId, events: list };
      const response = await pipeline.handleWebhook(
        "test",
        buildTestWebhookRequest({ secret: options.secret ?? TEST_SECRET, body }),
      );
      return {
        status: response.status,
        body: JSON.parse(response.body) as Record<string, unknown>,
      };
    },

    idle: () => runner.idle(),

    async messagesOf(tenant) {
      return t.admin
        .select()
        .from(messages)
        .where(eq(messages.businessId, tenant.tenant.businessId))
        .orderBy(asc(messages.conversationId), asc(messages.sequence));
    },

    async conversationsOf(tenant) {
      return t.admin
        .select()
        .from(conversations)
        .where(eq(conversations.businessId, tenant.tenant.businessId))
        .orderBy(asc(conversations.createdAt));
    },

    async dispose() {
      runner.stop();
      await runner.idle();
      await t.dispose();
    },
  };
}
