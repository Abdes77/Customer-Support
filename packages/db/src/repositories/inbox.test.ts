import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ConversationId } from "@repo/core";

import { attachments, auditLog, conversations, internalNotes, messages } from "../schema/tables";
import { createTestDatabase, createWorld, type TestDatabase, type World } from "../testing";
import {
  addInternalNote,
  assignConversation,
  deleteInternalNote,
  findVisibleAttachment,
  getConversationDetail,
  likePattern,
  listInbox,
  markConversationRead,
} from "./inbox";

/*
 * The inbox's reads as every kind of user (C16): row-level security decides, so a client
 * user sees only their own business (and nothing while client logins are off), staff see
 * their agency, notes reach staff only; and the system-scope writes behind the inbox's
 * actions (read state, assignment).
 */

let t: TestDatabase;
let world: World;

beforeAll(async () => {
  t = await createTestDatabase();
  world = await createWorld(t);
});
afterAll(async () => {
  await t.dispose();
});

const conversationOf = (key: "a1" | "a2" | "a3" | "b1") =>
  world.businesses[key].rows.get("conversations")!.fixture! as ConversationId;

describe("listInbox", () => {
  it("shows staff their agency's conversations and a client user only their own business", async () => {
    const staff = await t.db
      .asUser(world.users.aMember)
      .run((ctx) => listInbox(ctx, { businessIds: null, status: "all" }));
    const staffBusinesses = new Set(staff.rows.map((row) => row.businessId));
    expect(staffBusinesses).toEqual(
      new Set([
        world.businesses.a1.tenant.businessId,
        world.businesses.a2.tenant.businessId,
        world.businesses.a3.tenant.businessId,
      ]),
    );
    const owner = await t.db
      .asUser(world.users.a1Owner)
      .run((ctx) => listInbox(ctx, { businessIds: null, status: "all" }));
    expect(owner.rows.length).toBeGreaterThan(0);
    expect(new Set(owner.rows.map((row) => row.businessId))).toEqual(
      new Set([world.businesses.a1.tenant.businessId]),
    );
    // Client logins off: nothing.
    const off = await t.db
      .asUser(world.users.a3Owner)
      .run((ctx) => listInbox(ctx, { businessIds: null, status: "all" }));
    expect(off.rows).toEqual([]);
    // Asking for another business's id changes nothing.
    const swapped = await t.db.asUser(world.users.a1Owner).run((ctx) =>
      listInbox(ctx, {
        businessIds: null,
        status: "all",
        businessId: world.businesses.b1.tenant.businessId,
      }),
    );
    expect(swapped.rows).toEqual([]);
    // The caller's permission list narrows it further.
    const none = await t.db
      .asUser(world.users.a1Owner)
      .run((ctx) => listInbox(ctx, { businessIds: [], status: "all" }));
    expect(none.rows).toEqual([]);
  });

  it("filters by unread, assignment and search, with search terms taken literally", async () => {
    const id = conversationOf("a2");
    await t.admin
      .update(conversations)
      .set({ unreadCount: 3, subject: "100% leak_check", assignedUserId: world.users.aAdmin.id })
      .where(eq(conversations.id, id));
    const list = (filter: Parameters<typeof listInbox>[1], user = world.users.aAdmin) =>
      t.db.asUser(user).run((ctx) => listInbox(ctx, filter));
    const unread = await list({ businessIds: null, status: "all", unread: true });
    expect(unread.rows.map((row) => row.id)).toContain(id);
    expect(unread.rows.every((row) => row.unreadCount > 0)).toBe(true);
    const mine = await list({ businessIds: null, status: "all", assigned: "me" });
    expect(mine.rows.map((row) => row.id)).toEqual([id]);
    expect(mine.rows[0]?.assignedUserName).toBe("aAdmin");
    expect(
      (await list({ businessIds: null, status: "all", q: "100% leak_" })).rows.map((r) => r.id),
    ).toEqual([id]);
    // "%" and "_" are literal: "1_0" does not match "100".
    expect((await list({ businessIds: null, status: "all", q: "1_0%" })).rows).toEqual([]);
    expect(likePattern("50%_off\\")).toBe("%50\\%\\_off\\\\%");
    // Message text is searched too.
    const byText = await list({ businessIds: null, status: "all", q: "roof is leaking" });
    expect(byText.rows.length).toBeGreaterThan(0);
    // The newest message is shown with the row.
    expect(byText.rows[0]?.lastMessageText).toBe("My roof is leaking");
    expect(byText.rows[0]?.lastMessageAuthor).toBe("customer");
    // The client user of a1 never finds a2's conversation, whatever they search.
    const other = await list(
      { businessIds: null, status: "all", q: "leak_check" },
      world.users.a1Owner,
    );
    expect(other.rows).toEqual([]);
  });
});

describe("getConversationDetail", () => {
  it("returns the conversation to staff and its own client, notes to staff only", async () => {
    const id = conversationOf("a1");
    const staff = await t.db
      .asUser(world.users.aMember)
      .run((ctx) => getConversationDetail(ctx, id, { reports: true, notes: true }));
    expect(staff?.id).toBe(id);
    expect(staff?.notes.length).toBeGreaterThan(0);
    expect(staff?.lead?.report).not.toBeNull();
    const owner = await t.db
      .asUser(world.users.a1Owner)
      .run((ctx) => getConversationDetail(ctx, id, { reports: false, notes: true }));
    expect(owner?.id).toBe(id);
    // RLS keeps notes from client users even when asked for.
    expect(owner?.notes).toEqual([]);
    expect(owner?.lead?.report).toBeNull();
    // Without reports, routing decisions come without their reasons (the report's "why").
    expect(owner?.lead?.routing.every((decision) => decision.reasons.length === 0)).toBe(true);
    // Without the leads permission, no lead panel at all.
    const noLeads = await t.db
      .asUser(world.users.a1Owner)
      .run((ctx) => getConversationDetail(ctx, id, { reports: true, notes: false, lead: false }));
    expect(noLeads?.id).toBe(id);
    expect(noLeads?.lead).toBeNull();
    expect(noLeads?.bookings).toEqual([]);
    for (const user of [
      world.users.a2Owner,
      world.users.a3Owner,
      world.users.bAdmin,
      world.users.b1Owner,
      world.users.outsider,
    ]) {
      const seen = await t.db
        .asUser(user)
        .run((ctx) => getConversationDetail(ctx, id, { reports: true, notes: true }));
      expect(seen, `${user.email} must not see it`).toBeNull();
    }
    expect(
      await t.db
        .asUser(world.users.aAdmin)
        .run((ctx) => getConversationDetail(ctx, "not-a-uuid", { reports: true, notes: true })),
    ).toBeNull();
  });

  it("finds attachments only for people who may see the conversation", async () => {
    const attachmentId = world.businesses.a1.rows.get("attachments")!.fixture!;
    await t.admin
      .update(attachments)
      .set({ status: "stored", storagePath: "x/y/z/w/photo.jpg", mimeType: "image/jpeg" })
      .where(eq(attachments.id, attachmentId));
    const staff = await t.db
      .asUser(world.users.aAdmin)
      .run((ctx) => findVisibleAttachment(ctx, attachmentId));
    expect(staff?.storagePath).toBe("x/y/z/w/photo.jpg");
    const owner = await t.db
      .asUser(world.users.a1Owner)
      .run((ctx) => findVisibleAttachment(ctx, attachmentId));
    expect(owner?.businessId).toBe(world.businesses.a1.tenant.businessId);
    for (const user of [world.users.a2Owner, world.users.bAdmin, world.users.outsider]) {
      expect(
        await t.db.asUser(user).run((ctx) => findVisibleAttachment(ctx, attachmentId)),
      ).toBeNull();
    }
  });
});

describe("writes behind the inbox's actions", () => {
  it("marks read and assigns in the business's scope, staff only as assignees", async () => {
    const tenant = world.businesses.a1.tenant;
    const id = world.businesses.a1.rows.get("conversations")!.spare! as ConversationId;
    await t.admin.update(conversations).set({ unreadCount: 2 }).where(eq(conversations.id, id));
    const scope = t.db.forBusiness(tenant.businessId, { agencyId: tenant.agencyId });
    await scope.run((ctx) => markConversationRead(ctx, id));
    await scope.run((ctx) =>
      assignConversation(ctx, {
        conversationId: id,
        assigneeId: world.users.aMember.id,
        actorUserId: world.users.aAdmin.id,
      }),
    );
    const [row] = await t.admin.select().from(conversations).where(eq(conversations.id, id));
    expect(row).toMatchObject({ unreadCount: 0, assignedUserId: world.users.aMember.id });
    const audit = await t.admin.select().from(auditLog).where(eq(auditLog.targetId, id));
    expect(audit.map((entry) => entry.action)).toContain("conversation.assign");
    // A client user or another agency's staff cannot be the assignee.
    for (const assignee of [world.users.a1Owner.id, world.users.bAdmin.id]) {
      await expect(
        scope.run((ctx) =>
          assignConversation(ctx, {
            conversationId: id,
            assigneeId: assignee,
            actorUserId: world.users.aAdmin.id,
          }),
        ),
      ).rejects.toThrow(/agency's staff/);
    }
    // A conversation of another business is not found in this scope.
    await expect(
      scope.run((ctx) =>
        assignConversation(ctx, {
          conversationId: conversationOf("b1"),
          assigneeId: null,
          actorUserId: world.users.aAdmin.id,
        }),
      ),
    ).rejects.toThrow();
  });

  it("lets staff add notes under their own name, and nobody else", async () => {
    const tenant = world.businesses.a1.tenant;
    const id = conversationOf("a1");
    const note = await t.db
      .asUser(world.users.aMember)
      .run((ctx) =>
        addInternalNote(ctx, { ...tenant, conversationId: id, body: "  Called, left a message. " }),
      );
    const [row] = await t.admin.select().from(internalNotes).where(eq(internalNotes.id, note.id));
    expect(row).toMatchObject({
      body: "Called, left a message.",
      authorUserId: world.users.aMember.id,
    });
    // A client user, or staff of another agency, cannot add one.
    for (const user of [world.users.a1Owner, world.users.bAdmin]) {
      await expect(
        t.db
          .asUser(user)
          .run((ctx) => addInternalNote(ctx, { ...tenant, conversationId: id, body: "x" })),
      ).rejects.toThrow();
    }
    // A note naming another business's conversation fails its foreign key.
    await expect(
      t.db
        .asUser(world.users.aMember)
        .run((ctx) =>
          addInternalNote(ctx, { ...tenant, conversationId: conversationOf("a2"), body: "x" }),
        ),
    ).rejects.toThrow();
    // Another staff member cannot delete it; the admin can.
    expect(
      await t.db.asUser(world.users.bAdmin).run((ctx) => deleteInternalNote(ctx, note.id)),
    ).toBe(false);
    expect(
      await t.db.asUser(world.users.aAdmin).run((ctx) => deleteInternalNote(ctx, note.id)),
    ).toBe(true);
  });

  it("keeps message text out of the list unless the row is visible", async () => {
    const [message] = await t.admin
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.conversationId, conversationOf("b1")));
    expect(message).toBeDefined();
    const list = await t.db
      .asUser(world.users.aAdmin)
      .run((ctx) => listInbox(ctx, { businessIds: null, status: "all", q: "leaking" }));
    expect(list.rows.some((row) => row.businessId === world.businesses.b1.tenant.businessId)).toBe(
      false,
    );
  });
});
