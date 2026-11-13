import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  attachments,
  auditLog,
  contacts,
  conversations,
  eq,
  leads,
  messages,
  modelCalls,
  sql,
  storedUploads,
  takeoverLocks,
  usageCounters,
  widgetSessions,
} from "@repo/db";

import { createHarness, type Harness, message, type TestTenant } from "../testing/harness";
import { purgeAuditLog, purgeBusiness, purgeConversationIfDue } from "./purge";

/*
 * Retention (C17) on a fixed clock. Rows are made by the pipeline (real timestamps) and then
 * dated relative to the clock, so what counts as "old" never depends on the real date.
 */
const NOW = new Date("2026-06-15T16:00:00.000Z");
const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

let h: Harness;

beforeEach(async () => {
  h = await createHarness({ clock: () => new Date(NOW) });
});

afterEach(async () => {
  await h.dispose();
});

/** A conversation of `visitor`, its last activity dated `days` ago, with one stored photo. */
async function conversationAged(tenant: TestTenant, visitor: string, days: number) {
  await h.deliver(tenant, [message(`hello from ${visitor}`, { from: visitor })]);
  await h.idle();
  const rows = await h.conversationsOf(tenant);
  const conversation = rows.at(-1)!;
  const [inbound] = await h.t.admin
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.conversationId, conversation.id))
    .limit(1);
  const storage = h.pipeline.context.storage(tenant.tenant);
  const stored = await storage.putAttachment(
    { conversationId: conversation.id, messageId: inbound!.id, fileName: "roof.jpg" },
    new Uint8Array([1, 2, 3]),
    { contentType: "image/jpeg" },
  );
  await h.t.admin.insert(attachments).values({
    ...tenant.tenant,
    messageId: inbound!.id,
    kind: "image",
    mimeType: "image/jpeg",
    storageBucket: stored.bucket,
    storagePath: stored.path,
    status: "stored",
    analysis: "A sagging roof line.",
    createdAt: daysAgo(days),
  });
  const at = daysAgo(days);
  await h.t.admin
    .update(conversations)
    .set({ createdAt: at, lastMessageAt: at, lastOutboundAt: at })
    .where(eq(conversations.id, conversation.id));
  await h.t.admin
    .update(contacts)
    .set({ createdAt: at })
    .where(eq(contacts.id, conversation.contactId));
  // Every conversation that had a turn has a lead (C5); it last changed then too.
  await h.t.admin
    .update(leads)
    .set({ updatedAt: at })
    .where(eq(leads.conversationId, conversation.id));
  return { conversation, path: stored.path };
}

async function exists(tenant: TestTenant, path: string): Promise<boolean> {
  return (await h.pipeline.context.storage(tenant.tenant).get(path)) !== null;
}

const ref = (tenant: TestTenant) => ({ ...tenant.tenant, status: "active" as const });

describe("retention (C17)", () => {
  it("deletes conversations past their retention with their files and contact, and nothing newer", async () => {
    const tenant = await h.newTenant({
      "data.conversation_retention_days": 30,
      "data.lead_retention_days": 30,
    });
    const old = await conversationAged(tenant, "old-visitor", 45);
    const recent = await conversationAged(tenant, "new-visitor", 5);

    const result = await purgeBusiness(h.pipeline.context, ref(tenant));
    expect(result).toMatchObject({ conversationsDeleted: 1, contactsDeleted: 1 });

    const left = await h.conversationsOf(tenant);
    expect(left.map((row) => row.id)).toEqual([recent.conversation.id]);
    expect(await exists(tenant, old.path)).toBe(false);
    expect(await exists(tenant, recent.path)).toBe(true);
    const oldMessages = await h.t.admin
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.conversationId, old.conversation.id));
    expect(oldMessages).toEqual([]);
    const [contact] = await h.t.admin
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.id, old.conversation.contactId));
    expect(contact).toBeUndefined();

    // The paths recorded while the rows were deleted are forgotten once the files are gone.
    expect(
      await h.t.admin
        .select({ path: storedUploads.path })
        .from(storedUploads)
        .where(eq(storedUploads.businessId, tenant.tenant.businessId)),
    ).toEqual([]);

    // A second run has nothing left to do.
    expect(await purgeBusiness(h.pipeline.context, ref(tenant))).toMatchObject({
      conversationsDeleted: 0,
      filesDeleted: 0,
    });
  });

  it("leaves alone a conversation the customer wrote in after it was listed as due (audit)", async () => {
    const tenant = await h.newTenant({
      "data.conversation_retention_days": 30,
      "data.lead_retention_days": 30,
    });
    const old = await conversationAged(tenant, "returning-visitor", 45);
    // The job listed it as due... and before it got to deleting, the customer wrote again.
    // Deleting on the list alone would delete the message that just arrived.
    const listed = { id: old.conversation.id, leadUpdatedAt: daysAgo(45) };
    const cutoffs = { before: daysAgo(30), leadBefore: daysAgo(30), now: new Date(NOW) };
    await h.deliver(tenant, [
      message("hello again, are you still in business?", { from: "returning-visitor" }),
    ]);
    await h.idle();

    for (const candidate of [listed, { ...listed, leadUpdatedAt: new Date(NOW) }]) {
      expect(
        await purgeConversationIfDue(h.pipeline.context, ref(tenant), candidate, cutoffs),
      ).toEqual({ outcome: "skipped", files: 0 });
    }
    const kept = await h.t.admin
      .select({ text: messages.text })
      .from(messages)
      .where(eq(messages.conversationId, old.conversation.id));
    expect(kept.map((row) => row.text)).toContain("hello again, are you still in business?");
    expect(kept.map((row) => row.text)).toContain("hello from returning-visitor");
    expect(await exists(tenant, old.path)).toBe(true);
    // And the whole job agrees.
    expect(await purgeBusiness(h.pipeline.context, ref(tenant))).toMatchObject({
      conversationsDeleted: 0,
      conversationsEmptied: 0,
      filesDeleted: 0,
    });
  });

  it("finds the files of a deleted conversation again when storage failed after the rows were gone (audit)", async () => {
    const tenant = await h.newTenant({
      "data.conversation_retention_days": 30,
      "data.lead_retention_days": 30,
    });
    const old = await conversationAged(tenant, "unlucky-visitor", 45);
    const real = h.pipeline.context;
    const failing = {
      ...real,
      storage: (owner: Parameters<typeof real.storage>[0]) => ({
        ...real.storage(owner),
        remove: async () => {
          throw new Error("storage is down");
        },
      }),
    } as typeof real;
    await expect(
      purgeConversationIfDue(
        failing,
        ref(tenant),
        { id: old.conversation.id, leadUpdatedAt: daysAgo(45) },
        { before: daysAgo(30), leadBefore: daysAgo(30), now: new Date(NOW) },
      ),
    ).rejects.toThrow("storage is down");
    // The rows are gone, the file is not, and its path is on record.
    expect(await h.conversationsOf(tenant)).toEqual([]);
    expect(await exists(tenant, old.path)).toBe(true);
    const recorded = await h.t.admin
      .select({ path: storedUploads.path, source: storedUploads.source })
      .from(storedUploads)
      .where(eq(storedUploads.businessId, tenant.tenant.businessId));
    expect(recorded).toEqual([{ path: old.path, source: "retention" }]);

    // A day later the housekeeping pass deletes what nothing refers to.
    await h.t.admin
      .update(storedUploads)
      .set({ createdAt: daysAgo(2) })
      .where(eq(storedUploads.businessId, tenant.tenant.businessId));
    expect(await purgeBusiness(real, ref(tenant))).toMatchObject({ uploadsDeleted: 1 });
    expect(await exists(tenant, old.path)).toBe(false);
  });

  it("keeps a lead the business keeps longer, emptying its conversation instead", async () => {
    const tenant = await h.newTenant({
      "data.conversation_retention_days": 30,
      "data.lead_retention_days": null,
    });
    const old = await conversationAged(tenant, "lead-visitor", 60);

    const result = await purgeBusiness(h.pipeline.context, ref(tenant));
    expect(result).toMatchObject({ conversationsDeleted: 0, conversationsEmptied: 1 });
    const [conversation] = await h.t.admin
      .select({ metadata: conversations.metadata })
      .from(conversations)
      .where(eq(conversations.id, old.conversation.id));
    expect(conversation!.metadata).toHaveProperty("purgedAt");
    expect(
      await h.t.admin
        .select()
        .from(messages)
        .where(eq(messages.conversationId, old.conversation.id)),
    ).toEqual([]);
    expect(
      await h.t.admin
        .select({ id: leads.id })
        .from(leads)
        .where(eq(leads.conversationId, old.conversation.id)),
    ).toHaveLength(1);
    expect(await exists(tenant, old.path)).toBe(false);
  });

  it("waits while a person holds the conversation", async () => {
    const tenant = await h.newTenant({ "data.conversation_retention_days": 30 });
    const old = await conversationAged(tenant, "held-visitor", 90);
    await h.t.admin.insert(takeoverLocks).values({
      ...tenant.tenant,
      conversationId: old.conversation.id,
      source: "admin_panel",
      reason: "test",
      startedAt: daysAgo(1),
      lastActivityAt: daysAgo(1),
    } as never);
    expect(await purgeBusiness(h.pipeline.context, ref(tenant))).toMatchObject({
      conversationsDeleted: 0,
      conversationsEmptied: 0,
    });
  });

  it("deletes old files but keeps their descriptions, and trims old model records", async () => {
    const tenant = await h.newTenant({
      "data.conversation_retention_days": null,
      "data.attachment_retention_days": 7,
      "data.model_call_retention_days": 30,
    });
    const old = await conversationAged(tenant, "photo-visitor", 10);
    await h.t.admin.insert(modelCalls).values([
      {
        ...tenant.tenant,
        traceId: randomUUID() as never,
        purpose: "reply",
        model: "claude-fable-5-2",
        effort: "medium",
        promptVersion: "t",
        startedAt: daysAgo(40),
        latencyMs: 1,
        costMicroUsd: 1234,
        request: { messages: ["customer text"] },
        response: { content: "bot text" },
      },
      {
        ...tenant.tenant,
        traceId: randomUUID() as never,
        purpose: "reply",
        model: "claude-fable-5-2",
        effort: "medium",
        promptVersion: "t",
        startedAt: daysAgo(2),
        latencyMs: 1,
        request: { messages: ["recent"] },
      },
    ]);
    const result = await purgeBusiness(h.pipeline.context, ref(tenant));
    expect(result).toMatchObject({
      filesDeleted: 1,
      modelCallsTrimmed: 1,
      conversationsDeleted: 0,
    });
    expect(await exists(tenant, old.path)).toBe(false);
    const [file] = await h.t.admin
      .select({
        status: attachments.status,
        path: attachments.storagePath,
        analysis: attachments.analysis,
      })
      .from(attachments)
      .where(eq(attachments.businessId, tenant.tenant.businessId));
    expect(file).toEqual({ status: "purged", path: null, analysis: "A sagging roof line." });
    const calls = await h.t.admin
      .select({ request: modelCalls.request, cost: modelCalls.costMicroUsd })
      .from(modelCalls)
      .where(eq(modelCalls.businessId, tenant.tenant.businessId))
      .orderBy(modelCalls.startedAt);
    expect(calls).toEqual([
      { request: null, cost: 1234 },
      { request: { messages: ["recent"] }, cost: null },
    ]);
  });

  it("cleans up expired chat sessions, finished counters and uploads that were never ingested", async () => {
    const tenant = await h.newTenant({});
    const storage = h.pipeline.context.storage(tenant.tenant);
    const orphan = await storage.putUpload(
      { ownerId: randomUUID(), uploadId: randomUUID(), fileName: "a.jpg" },
      new Uint8Array([1]),
      { contentType: "image/jpeg" },
    );
    const fresh = await storage.putUpload(
      { ownerId: randomUUID(), uploadId: randomUUID(), fileName: "b.jpg" },
      new Uint8Array([2]),
      { contentType: "image/jpeg" },
    );
    await h.t.admin.insert(storedUploads).values([
      { ...tenant.tenant, path: orphan.path, source: "widget", createdAt: daysAgo(2) },
      { ...tenant.tenant, path: fresh.path, source: "widget", createdAt: new Date(NOW) },
    ]);
    await h.t.admin.insert(widgetSessions).values([
      {
        ...tenant.tenant,
        channelConnectionId: tenant.connectionId as never,
        visitorId: "expired",
        expiresAt: daysAgo(10),
      },
      {
        ...tenant.tenant,
        channelConnectionId: tenant.connectionId as never,
        visitorId: "live",
        expiresAt: new Date(NOW.getTime() + DAY),
      },
    ]);
    await h.t.admin.insert(usageCounters).values([
      { ...tenant.tenant, metric: "old", windowStart: daysAgo(5), windowSeconds: 3600, value: 1 },
      {
        ...tenant.tenant,
        metric: "current",
        windowStart: new Date(NOW),
        windowSeconds: 3600,
        value: 1,
      },
    ]);

    const result = await purgeBusiness(h.pipeline.context, ref(tenant));
    expect(result).toMatchObject({ uploadsDeleted: 1, widgetSessionsDeleted: 1 });
    expect(await exists(tenant, orphan.path)).toBe(false);
    expect(await exists(tenant, fresh.path)).toBe(true);
    const sessions = await h.t.admin
      .select({ visitor: widgetSessions.visitorId })
      .from(widgetSessions)
      .where(eq(widgetSessions.businessId, tenant.tenant.businessId));
    expect(sessions).toEqual([{ visitor: "live" }]);
    const counters = await h.t.admin
      .select({ metric: usageCounters.metric })
      .from(usageCounters)
      .where(eq(usageCounters.businessId, tenant.tenant.businessId));
    expect(counters.map((row) => row.metric)).not.toContain("old");
    expect(counters.map((row) => row.metric)).toContain("current");
  });

  it("purges the audit log only in an agency-wide scope and never younger than 90 days", async () => {
    const tenant = await h.newTenant({});
    // Another agency with an entry just as old: its log is not this purge's to touch.
    const other = await h.newTenant({});
    expect(other.tenant.agencyId).not.toBe(tenant.tenant.agencyId);
    await h.t.admin.insert(auditLog).values([
      {
        agencyId: tenant.tenant.agencyId,
        actorType: "system",
        action: "old.entry",
        createdAt: new Date("2020-01-01T00:00:00Z"),
      },
      { agencyId: tenant.tenant.agencyId, actorType: "system", action: "recent.entry" },
      {
        agencyId: other.tenant.agencyId,
        actorType: "system",
        action: "old.entry.elsewhere",
        createdAt: new Date("2020-01-01T00:00:00Z"),
      },
    ] as never);
    expect(await purgeAuditLog(h.pipeline.context, tenant.tenant.agencyId, 365)).toBe(1);
    const elsewhere = await h.t.admin
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.agencyId, other.tenant.agencyId));
    expect(elsewhere.map((row) => row.action)).toContain("old.entry.elsewhere");
    const left = await h.t.admin
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.agencyId, tenant.tenant.agencyId));
    expect(left.map((row) => row.action)).toContain("recent.entry");
    expect(left.map((row) => row.action)).not.toContain("old.entry");

    // A business scope may not purge; nor may anyone ask for less than 90 days.
    await expect(
      h.t.db
        .forBusiness(tenant.tenant.businessId)
        .run((ctx) => ctx.tx.execute(sql`select app.purge_audit_log(now() - interval '400 days')`)),
    ).rejects.toThrow();
    await expect(
      h.t.db
        .forAgency(tenant.tenant.agencyId)
        .run((ctx) => ctx.tx.execute(sql`select app.purge_audit_log(now() - interval '10 days')`)),
    ).rejects.toThrow();
  });
});
