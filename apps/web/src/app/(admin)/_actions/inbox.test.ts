import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createLogger } from "@repo/core";
import { type DeploymentInfo, loadEnv } from "@repo/core/env";
import {
  and,
  attachments,
  eq,
  internalNotes,
  isNull,
  loadUserAccess,
  messages,
  takeoverLocks,
  type UserIdentity,
} from "@repo/db";
import { MemoryObjectStore, createTenantStorage } from "@repo/db/storage";
import { createTestDatabase, createWorld, type TestDatabase, type World } from "@repo/db/testing";
import { createLocalJobRunner, type LocalJobRunner } from "@repo/jobs";
import { applySettingChanges } from "@repo/settings/server";

import { contentDisposition, serveAttachment } from "@/server/attachments";
import { buildServerPipeline, type ServerPipeline } from "@/server/pipeline";

/*
 * The inbox's server actions (C16) as the signed-in person, against a real database: staff of
 * the agency, staff of another agency, client users with and without the client-portal
 * permissions, a signed-out visitor and a cross-site request, with ids swapped for another
 * tenant's. Next.js is replaced by the smallest stand-ins, as in actions.test.ts.
 */

const local: DeploymentInfo = { environment: "local", commitSha: null, region: null };
const quiet = createLogger({ level: "error", sink: () => {} });

let t: TestDatabase;
let world: World;
let runner: LocalJobRunner;
let server: ServerPipeline;
let currentUser: UserIdentity | null = null;
const SAME_ORIGIN = {
  origin: "http://localhost:3000",
  host: "localhost:3000",
  "sec-fetch-site": "same-origin",
};
let requestHeaders = new Headers(SAME_ORIGIN);

vi.mock("next/headers", () => ({
  headers: async () => requestHeaders,
  cookies: async () => ({ get: () => undefined, getAll: () => [], set() {}, delete() {} }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/auth", () => {
  const userDatabase = (user: UserIdentity) => t.db.asUser({ id: user.id, email: user.email });
  const getAccess = async () =>
    currentUser === null
      ? null
      : {
          user: { id: currentUser.id, email: currentUser.email ?? null },
          access: await userDatabase(currentUser).run((ctx) => loadUserAccess(ctx)),
        };
  return {
    getAccess,
    requireAccess: async () => {
      const session = await getAccess();
      if (session === null) throw new Error("signed out");
      return session;
    },
    userDatabase,
  };
});
vi.mock("@repo/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDatabase: () => t.db,
}));
vi.mock("@/server/handoff", () => ({ getHandoff: () => server.handoff.service }));

const inbox = () => import("./inbox");

beforeAll(async () => {
  t = await createTestDatabase();
  world = await createWorld(t);
  runner = createLocalJobRunner({ logger: quiet, retryDelayMs: () => 10 });
  server = buildServerPipeline({
    db: t.db,
    env: loadEnv({}),
    deployment: local,
    logger: quiet,
    runner,
    testChannelSecret: "web-test-channel-secret-0123456789abcdef",
  });
});

afterAll(async () => {
  runner?.stop();
  await runner?.idle();
  await t?.dispose();
});

function as(user: UserIdentity | null): void {
  currentUser = user;
  requestHeaders = new Headers(SAME_ORIGIN);
}

const conversationOf = (key: "a1" | "a2" | "a3" | "b1", which: "fixture" | "spare" = "fixture") =>
  world.businesses[key].rows.get("conversations")![which]!;

async function setPortal(key: "a1" | "a2" | "b1", values: Record<string, unknown>) {
  const tenant = world.businesses[key].tenant;
  await t.db.forBusiness(tenant.businessId, { agencyId: tenant.agencyId }).run((ctx) =>
    applySettingChanges(ctx, {
      target: { scope: "business", ...tenant },
      changes: Object.entries(values).map(([key, value]) => ({ key, value })),
      actor: { type: "system", label: "test" },
    }),
  );
}

async function activeLock(conversationId: string) {
  const [row] = await t.admin
    .select()
    .from(takeoverLocks)
    .where(
      and(
        eq(takeoverLocks.conversationId, conversationId as never),
        isNull(takeoverLocks.releasedAt),
      ),
    );
  return row ?? null;
}

async function humanReplies(conversationId: string) {
  return t.admin
    .select()
    .from(messages)
    .where(
      and(eq(messages.conversationId, conversationId as never), eq(messages.author, "human_agent")),
    );
}

describe("takeover and manual reply", () => {
  it("lets staff take over, reply once per key through the conversation, and release", async () => {
    const { takeOverAction, sendReplyAction, releaseAction, typingAction } = await inbox();
    const conversationId = conversationOf("a1", "spare");
    as(world.users.aMember);
    // No reply before the takeover.
    const early = await sendReplyAction({ conversationId, text: "Hello", key: "draft-0001" });
    expect(early).toMatchObject({ ok: false });
    expect((await takeOverAction({ conversationId })).ok).toBe(true);
    expect((await activeLock(conversationId))?.userId).toBe(world.users.aMember.id);
    expect(await typingAction({ conversationId })).toEqual({ ok: true, value: true });
    const first = await sendReplyAction({
      conversationId,
      text: "Hi, Sam here.",
      key: "draft-0002",
    });
    const again = await sendReplyAction({
      conversationId,
      text: "Hi, Sam here.",
      key: "draft-0002",
    });
    expect(first).toMatchObject({ ok: true, value: { duplicate: false } });
    expect(again).toMatchObject({ ok: true, value: { duplicate: true } });
    await runner.idle();
    const replies = await humanReplies(conversationId);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      text: "Hi, Sam here.",
      authorUserId: world.users.aMember.id,
      direction: "outbound",
    });
    // Another staff member of the agency cannot reply while Sam holds it.
    as(world.users.aAdmin);
    expect(await takeOverAction({ conversationId })).toMatchObject({ ok: false });
    expect(
      await sendReplyAction({ conversationId, text: "Me too", key: "draft-0003" }),
    ).toMatchObject({ ok: false });
    // Release hands it back to the bot once.
    as(world.users.aMember);
    expect(await releaseAction({ conversationId })).toEqual({
      ok: true,
      value: "The bot has the conversation again.",
    });
    expect(await releaseAction({ conversationId })).toEqual({
      ok: true,
      value: "The bot already had it.",
    });
    expect(await activeLock(conversationId)).toBeNull();
  });

  it("refuses other tenants, client users without the permission, signed-out and cross-site requests", async () => {
    const { takeOverAction, sendReplyAction } = await inbox();
    const conversationId = conversationOf("a2");
    for (const user of [world.users.bAdmin, world.users.b1Owner, world.users.a1Owner]) {
      as(user);
      expect(await takeOverAction({ conversationId }), `${user.email}`).toMatchObject({
        ok: false,
        error: "That conversation was not found.",
      });
    }
    // No access at all (client logins off, no membership): the session reaches nothing.
    for (const user of [world.users.a3Owner, world.users.outsider]) {
      as(user);
      expect(await takeOverAction({ conversationId })).toMatchObject({ ok: false });
    }
    // The owner of a2 sees it, but replying is "nobody" by default.
    as(world.users.a2Owner);
    expect(await takeOverAction({ conversationId })).toMatchObject({
      ok: false,
      error: "You cannot take over or reply in this business's conversations.",
    });
    as(null);
    expect(await takeOverAction({ conversationId })).toMatchObject({ ok: false });
    as(world.users.aAdmin);
    requestHeaders = new Headers({
      origin: "https://evil.example",
      host: "localhost:3000",
      "sec-fetch-site": "cross-site",
    });
    expect(await takeOverAction({ conversationId })).toMatchObject({ ok: false });
    // (The world's fixture lock belongs to the agency member; the admin took nothing.)
    expect((await activeLock(conversationId))?.userId).not.toBe(world.users.aAdmin.id);
    as(world.users.aAdmin);
    expect(
      await sendReplyAction({ conversationId: "not-a-uuid", text: "x", key: "draft-0004" }),
    ).toMatchObject({ ok: false });
  });

  it("lets a client owner reply when the business allows it, but not their staff", async () => {
    const { takeOverAction, sendReplyAction, releaseAction } = await inbox();
    await setPortal("a1", { "client_portal.reply_and_take_over": "owner" });
    // The fixture conversation has a staff member's takeover; the spare one is free.
    const conversationId = conversationOf("a1", "spare");
    as(world.users.a1Staff);
    expect(await takeOverAction({ conversationId })).toMatchObject({ ok: false });
    as(world.users.a1Owner);
    expect((await takeOverAction({ conversationId })).ok).toBe(true);
    expect(
      (await sendReplyAction({ conversationId, text: "Owner here.", key: "owner-draft-1" })).ok,
    ).toBe(true);
    expect((await releaseAction({ conversationId })).ok).toBe(true);
    // Turning the permission off closes it again, without a new session.
    await setPortal("a1", { "client_portal.reply_and_take_over": "nobody" });
    expect(await takeOverAction({ conversationId })).toMatchObject({ ok: false });
    // Seeing conversations switched off: the conversation is "not found" to them.
    await setPortal("a1", { "client_portal.view_conversations": "nobody" });
    expect(await takeOverAction({ conversationId })).toMatchObject({
      ok: false,
      error: "That conversation was not found.",
    });
    await setPortal("a1", { "client_portal.view_conversations": "owner_and_staff" });
  });
});

describe("notes and assignment", () => {
  it("are staff only, and a swapped id finds nothing", async () => {
    const { addNoteAction, assignAction, deleteNoteAction } = await inbox();
    const conversationId = conversationOf("a1");
    as(world.users.a1Owner);
    expect(await addNoteAction({ conversationId, body: "client note" })).toMatchObject({
      ok: false,
      error: "Only agency staff can do that.",
    });
    expect(
      await assignAction({ conversationId, assigneeId: world.users.aMember.id }),
    ).toMatchObject({ ok: false });
    as(world.users.bAdmin);
    expect(await addNoteAction({ conversationId, body: "other agency" })).toMatchObject({
      ok: false,
      error: "That conversation was not found.",
    });
    as(world.users.aMember);
    expect(await addNoteAction({ conversationId, body: "<script>alert(1)</script>" })).toEqual({
      ok: true,
      value: "Note added.",
    });
    const [note] = await t.admin
      .select()
      .from(internalNotes)
      .where(eq(internalNotes.body, "<script>alert(1)</script>"));
    expect(note?.authorUserId).toBe(world.users.aMember.id);
    // A note id with another conversation's id: the note is not deleted.
    as(world.users.bAdmin);
    expect(
      await deleteNoteAction({ conversationId: conversationOf("b1"), noteId: note!.id }),
    ).toMatchObject({ ok: false });
    as(world.users.aMember);
    expect(
      await assignAction({ conversationId, assigneeId: world.users.bMember.id }),
    ).toMatchObject({ ok: false });
    expect(await assignAction({ conversationId, assigneeId: world.users.aAdmin.id })).toEqual({
      ok: true,
      value: "Assigned.",
    });
    expect(await deleteNoteAction({ conversationId, noteId: note!.id })).toEqual({
      ok: true,
      value: "Note deleted.",
    });
  });
});

describe("attachments", () => {
  it("serve a file only to people who may read the conversation, never as active content", async () => {
    const tenant = world.businesses.a1.tenant;
    const store = new MemoryObjectStore();
    const storage = () => createTenantStorage(store, tenant);
    const attachmentId = world.businesses.a1.rows.get("attachments")!.fixture!;
    const path = `${tenant.agencyId}/${tenant.businessId}/c/m/page.html`;
    await store.put(path, new TextEncoder().encode("<script>alert(1)</script>"), {
      contentType: "text/html",
    });
    await t.admin
      .update(attachments)
      .set({ status: "stored", storagePath: path, mimeType: "text/html", fileName: 'pa"ge.html' })
      .where(eq(attachments.id, attachmentId as never));
    const serve = (user: UserIdentity | null) => {
      as(user);
      return serveAttachment(
        {
          getAccess: async () =>
            user === null
              ? null
              : {
                  user: { id: user.id, email: user.email ?? null },
                  access: await t.db.asUser(user).run((ctx) => loadUserAccess(ctx)),
                },
          storage,
        },
        attachmentId,
      );
    };
    const staff = await serve(world.users.aMember);
    expect(staff.status).toBe(200);
    expect(staff.headers.get("content-type")).toBe("application/octet-stream");
    expect(staff.headers.get("content-disposition")).toMatch(/^attachment; filename="pa_ge.html"/);
    expect(staff.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await serve(world.users.a1Owner)).status).toBe(200);
    for (const user of [world.users.a2Owner, world.users.bAdmin, world.users.outsider, null]) {
      expect((await serve(user)).status).toBe(404);
    }
    await setPortal("a1", { "client_portal.view_conversations": "nobody" });
    expect((await serve(world.users.a1Owner)).status).toBe(404);
    await setPortal("a1", { "client_portal.view_conversations": "owner_and_staff" });
    expect(contentDisposition("inline", "fötö\r\n.jpg")).toBe(
      `inline; filename="f_t___.jpg"; filename*=UTF-8''f%C3%B6t%C3%B6__.jpg`,
    );
  });
});
