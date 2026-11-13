import { generateKeyPairSync, sign } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseEmail } from "@repo/channel-email";
import { graphClientState, type JsonWebKeySet } from "@repo/channel-email/server";
import {
  bounce,
  createFakeGmail,
  createFakeGraph,
  type FakeGmail,
  type FakeGraph,
  type LocalMailServer,
  newsletter,
  outOfOffice,
  rawEmail,
  startLocalMailServer,
} from "@repo/channel-email/testing";
import { type AgencyId, type BusinessId, createLogger, type UserId } from "@repo/core";
import { type DeploymentInfo, loadEnv } from "@repo/core/env";
import {
  and,
  businesses,
  channelConnections,
  conversations,
  conversationTurns,
  eq,
  messages,
  segments,
  sql,
  takeoverLocks,
} from "@repo/db";
import { createTenantStorage, MemoryObjectStore } from "@repo/db/storage";
import { createTestDatabase, TEST_ENCRYPTION_KEY, type TestDatabase } from "@repo/db/testing";
import { createLocalJobRunner, type LocalJobRunner } from "@repo/jobs";
import type { AppSettings } from "@repo/settings";
import { applySettingChanges } from "@repo/settings/server";

import type { SessionAccess } from "@/server/auth";
import { buildServerPipeline, type ServerPipeline } from "@/server/pipeline";

import {
  createImapConnectHandler,
  createOAuthCallbackHandler,
  createOAuthStartHandler,
  handleNotification,
} from "./routes";

/*
 * Email end to end, without Google or Microsoft: a real IMAP/SMTP server in the test process
 * (ImapKit with its SMTP listener, TLS with its test certificate) and fakes of the Gmail API
 * and Microsoft Graph. Mail goes through the real notification and connect routes, the sync
 * job, ingest, the reply turn with the offline engine, the composer, the send step and the
 * adapter. The live versions are in HUMAN_TODO 14.
 */

const local: DeploymentInfo = { environment: "local", commitSha: null, region: null };
const quiet = createLogger({ level: "error", sink: () => {} });
const APP_URL = "https://app.example.com";
const PUSH_ACCOUNT = "gmail-push@acme-project.iam.gserviceaccount.com";
const CLIENT_STATE_SECRET = "graph-client-state-secret-for-web-tests";

let t: TestDatabase;
let mail: LocalMailServer;
let gmail: FakeGmail;
let graph: FakeGraph;
let runner: LocalJobRunner;
let server: ServerPipeline;
let tenant: { agencyId: AgencyId; businessId: BusinessId };
let adminId: UserId;

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks: JsonWebKeySet = {
  keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256" }],
};

function pushToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const claims = Buffer.from(
    JSON.stringify({
      iss: "https://accounts.google.com",
      aud: `${APP_URL}/api/webhooks/email/gmail`,
      email: PUSH_ACCOUNT,
      email_verified: true,
      iat: now,
      exp: now + 3600,
    }),
  ).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), keys.privateKey);
  return `${header}.${claims}.${signature.toString("base64url")}`;
}

const session = (): SessionAccess => ({
  user: { id: adminId, email: null },
  access: {
    userId: adminId,
    agencies: [{ agencyId: tenant.agencyId, role: "agency_admin" }],
    businesses: [],
  },
});

const routeDeps = () => ({
  getAccess: async () => session(),
  getEmail: () => server.email.connections,
  directory: t.db.directory,
  appUrl: APP_URL,
  logger: quiet,
});

async function setSettings(values: Partial<AppSettings>) {
  await t.db.forBusiness(tenant.businessId).run((ctx) =>
    applySettingChanges(ctx, {
      target: { scope: "business", ...tenant },
      changes: Object.entries(values).map(([key, value]) => ({ key, value: value as never })),
      actor: { type: "system", label: "web email tests" },
    }),
  );
}

/** The conversation rows of a customer address, oldest first. */
async function thread(customerAddress: string) {
  const list = await t.admin
    .select({ id: conversations.id, thread: conversations.externalThreadId })
    .from(conversations)
    .where(
      and(
        eq(conversations.businessId, tenant.businessId),
        sql`${conversations.contactId} in (select contact_id from contact_identities where external_id = ${customerAddress})`,
      ),
    );
  const rows =
    list.length === 0
      ? []
      : await t.admin
          .select()
          .from(messages)
          .where(
            sql`${messages.conversationId} in (${sql.join(
              list.map((item) => sql`${item.id}::uuid`),
              sql`, `,
            )})`,
          )
          .orderBy(messages.createdAt, messages.sequence);
  return { conversations: list, rows };
}

async function pollAndSettle() {
  await runner.runCron("email-poll");
  await runner.idle();
}

const unique = () => Math.random().toString(36).slice(2, 10);

beforeAll(async () => {
  t = await createTestDatabase();
  mail = await startLocalMailServer({ address: "office@acme-roofing.com" });
  gmail = createFakeGmail({ address: "acme.gmail.office@acme-roofing.net" });
  graph = createFakeGraph({ address: "office@acme-roofing.org" });
  runner = createLocalJobRunner({ logger: quiet, debouncePeriodMs: 20, retryDelayMs: () => 10 });
  const store = new MemoryObjectStore();
  server = buildServerPipeline({
    db: t.db,
    env: loadEnv({
      APP_URL,
      CREDENTIALS_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
      GOOGLE_CLIENT_ID: "google-client",
      GOOGLE_CLIENT_SECRET: "google-secret",
      GOOGLE_PUBSUB_TOPIC: "projects/acme/topics/gmail",
      GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT: PUSH_ACCOUNT,
      MICROSOFT_CLIENT_ID: "ms-client",
      MICROSOFT_CLIENT_SECRET: "ms-secret",
      MICROSOFT_GRAPH_CLIENT_STATE: CLIENT_STATE_SECRET,
    }),
    deployment: local,
    logger: quiet,
    runner,
    testChannelSecret: "web-test-channel-secret-0123456789",
    storage: (owner) => createTenantStorage(store, owner),
    emailFetch: (input, init) =>
      new URL(input).hostname.includes("microsoft")
        ? graph.fetch(input, init)
        : gmail.fetch(input, init),
    mailPolicy: mail.policy,
    googleKeys: async () => jwks,
    emailJobs: { debounce: null },
  });
  const { id: agencyId } = await t.db.platform.createAgency({ name: "Agency", slug: "agency" });
  const [segment] = await t.admin
    .insert(segments)
    .values({ agencyId, slug: "roofing", name: "Roofing" })
    .returning({ id: segments.id });
  const [business] = await t.admin
    .insert(businesses)
    .values({
      agencyId,
      segmentId: segment!.id,
      name: "Acme Roofing",
      slug: "acme",
      status: "active",
      phone: "+15125550100",
      timezone: "America/Chicago",
    })
    .returning({ id: businesses.id });
  tenant = { agencyId, businessId: business!.id };
  adminId = (await t.db.localAuth.upsertUser({ email: "admin@agency.test", fullName: "Admin" })).id;
  await setSettings({
    "conversation.reply_wait_seconds.email": 0,
    "persona.bot_name": "Sam",
    "channels.email.signature": "{{bot_name}}\n{{business_name}}\n{{business_phone}}",
  });
});

afterAll(async () => {
  runner?.stop();
  await runner?.idle();
  await mail?.stop();
  await t?.dispose();
});

describe("IMAP/SMTP round trip against a local mail server", () => {
  let connectionId: string;

  it("connects the inbox through the route, checking both logins", async () => {
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      new Request(`${APP_URL}/api/channels/email/imap`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: APP_URL, ...headers },
        body: JSON.stringify(body),
      });
    const handler = createImapConnectHandler(routeDeps());
    const body = {
      businessId: tenant.businessId,
      address: mail.address,
      displayName: "Acme Roofing",
      imap: mail.imap,
      smtp: mail.smtp,
      imapPassword: mail.password,
    };
    // Another site cannot post it; a client user cannot; a wrong password stores nothing.
    expect(
      (
        await handler(
          post(body, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }),
        )
      ).status,
    ).toBe(403);
    const clientUser = createImapConnectHandler({
      ...routeDeps(),
      getAccess: async () => ({
        user: { id: adminId, email: null },
        access: {
          userId: adminId,
          agencies: [],
          businesses: [
            {
              businessId: tenant.businessId,
              agencyId: tenant.agencyId,
              role: "client_owner",
              enabled: true,
            },
          ],
        },
      }),
    });
    expect((await clientUser(post(body))).status).toBe(403);
    expect((await handler(post({ ...body, imapPassword: "wrong" }))).status).toBe(400);

    const response = await handler(post(body));
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      connection: { connectionId: string; provider: string; delivery: string };
    };
    expect(result.connection).toMatchObject({ provider: "imap", delivery: "polling" });
    expect(JSON.stringify(result)).not.toContain(mail.password);
    connectionId = result.connection.connectionId;
  });

  it("answers a customer's email in the same thread, and the customer's reply continues it", async () => {
    const customer = `maria.${unique()}@example.com`;
    const firstId = `<first-${unique()}@mail.example.com>`;
    mail.deliver(
      rawEmail({
        from: `"MARIA LOPEZ" <${customer}>`,
        to: mail.address,
        subject: "Roof leak in the kitchen",
        messageId: firstId,
        text: "Hi, my kitchen ceiling started leaking after the storm. Can someone take a look this week?\n\nThanks,\nMaria",
      }),
    );
    const before = mail.messages("INBOX").length;
    await pollAndSettle();

    const first = await thread(customer);
    expect(first.conversations).toHaveLength(1);
    expect(first.conversations[0]!.thread).toBe(`mid:${firstId}`);
    const inbound = first.rows.filter((row) => row.direction === "inbound");
    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.text).toContain("kitchen ceiling started leaking");
    const replies = first.rows.filter((row) => row.direction === "outbound");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ status: "sent", author: "bot", kind: "email" });

    // The reply reached the mail server: ImapKit's SMTP listener drops it into the INBOX.
    const delivered = mail.messages("INBOX").slice(before);
    const replyRaw = delivered.find((message) =>
      message.raw.includes(replies[0]!.externalMessageId!),
    );
    expect(replyRaw).toBeDefined();
    const reply = await parseEmail(replyRaw!.raw);
    expect(reply.messageId).toBe(replies[0]!.externalMessageId);
    expect(reply.inReplyTo).toBe(firstId);
    expect(reply.references).toEqual([firstId]);
    expect(reply.subject).toBe("Re: Roof leak in the kitchen");
    expect(reply.from).toEqual({ address: mail.address, name: "Sam at Acme Roofing" });
    expect(reply.to.map((item) => item.address)).toEqual([customer]);
    expect(reply.text).toContain("Sam\nAcme Roofing\n+15125550100");
    // The first email of an address is never quoted back to it (C17: From can be forged, and
    // the business's inbox must not deliver a stranger's text to the address they chose).
    expect(reply.text).not.toContain("> Hi, my kitchen ceiling started leaking");
    expect(reply.html).not.toContain('<div class="gmail_quote">');
    // A copy is in Sent, as a mail program would leave it.
    expect(mail.messages("Sent").some((message) => message.raw.includes(reply.messageId!))).toBe(
      true,
    );

    // The customer answers in the thread (their client keeps the References chain).
    mail.deliver(
      rawEmail({
        from: `"Maria Lopez" <${customer}>`,
        to: mail.address,
        subject: "Re: Roof leak in the kitchen",
        messageId: `<second-${unique()}@mail.example.com>`,
        inReplyTo: reply.messageId!,
        references: `${firstId} ${reply.messageId!}`,
        text: `Yes, I own the house. It's about 15 years old.\n\nOn Wed, Nov 11, 2026 at 3:10 PM Sam <${mail.address}> wrote:\n> ${reply.text!.split("\n")[0]}`,
      }),
    );
    await pollAndSettle();
    const second = await thread(customer);
    expect(second.conversations).toHaveLength(1);
    const secondInbound = second.rows.filter((row) => row.direction === "inbound").at(-1)!;
    // The quoted earlier message is cut: the bot reads what is new.
    expect(secondInbound.text).toBe("Yes, I own the house. It's about 15 years old.");
    const secondReplies = second.rows.filter((row) => row.direction === "outbound");
    expect(secondReplies).toHaveLength(2);
    const secondRaw = mail
      .messages("INBOX")
      .find((message) => message.raw.includes(secondReplies[1]!.externalMessageId!))!;
    const secondReply = await parseEmail(secondRaw.raw);
    expect(secondReply.inReplyTo).toBe(secondInbound.externalMessageId);
    expect(secondReply.references).toEqual([
      firstId,
      reply.messageId,
      secondInbound.externalMessageId,
    ]);
    // The address wrote again, in reply to us: now the customer's words are quoted.
    expect(secondReply.text).toContain("> Yes, I own the house.");
    expect(secondReply.html).toContain('<div class="gmail_quote">');
    // Our own mail coming back through the INBOX and the Sent folder was never stored as a
    // customer's message.
    expect(second.rows.filter((row) => row.direction === "inbound")).toHaveLength(2);
  });

  it("ignores newsletters and out-of-office replies, and a bounce marks our email failed", async () => {
    const customer = `pat.${unique()}@example.net`;
    const firstId = `<q-${unique()}@example.net>`;
    mail.deliver(
      rawEmail({
        from: `Pat <${customer}>`,
        to: mail.address,
        messageId: firstId,
        subject: "Gutter quote",
      }),
    );
    await pollAndSettle();
    const replies = (await thread(customer)).rows.filter((row) => row.direction === "outbound");
    expect(replies).toHaveLength(1);
    const ours = replies[0]!.externalMessageId!;

    // An out-of-office answer to our reply: kept for the team, never answered.
    mail.deliver(
      outOfOffice(ours)
        .replace(/maria\.lopez@example\.com/g, customer)
        .replace("<oof-1@example.com>", `<oof-${unique()}@example.net>`),
    );
    // A newsletter: not stored at all.
    mail.deliver(newsletter());
    await pollAndSettle();
    const after = await thread(customer);
    expect(after.rows.filter((row) => row.direction === "outbound")).toHaveLength(1);
    const automatic = after.rows.filter((row) => row.direction === "inbound").at(-1)!;
    expect(automatic.payload).toMatchObject({ metadata: { automated: "auto_reply" } });
    const [turn] = await t.admin
      .select({ status: conversationTurns.status, reason: conversationTurns.skipReason })
      .from(conversationTurns)
      .where(eq(conversationTurns.conversationId, after.conversations[0]!.id))
      .orderBy(sql`${conversationTurns.ordinal} desc`)
      .limit(1);
    expect(turn).toEqual({ status: "skipped", reason: "email_channel:automatic_mail" });
    expect((await thread("news@roofsupply.example")).conversations).toEqual([]);

    // A forged bounce: it names our reply but another recipient, or the receiving server
    // says its sender failed DMARC. Neither marks the reply failed (C17).
    mail.deliver(
      bounce(ours)
        .replace(/office@acme-roofing\.com/g, mail.address)
        .replace("<dsn-1@mx.acme-roofing.com>", `<dsn-x-${unique()}@mx.acme-roofing.com>`),
    );
    mail.deliver(
      `Authentication-Results: mx.mail.test; spf=fail smtp.mailfrom=mx.acme-roofing.com; dmarc=fail header.from=mx.acme-roofing.com\r\n${bounce(
        ours,
      )
        .replace(/office@acme-roofing\.com/g, mail.address)
        .replace(/nobody@example\.com/g, customer)
        .replace("<dsn-1@mx.acme-roofing.com>", `<dsn-y-${unique()}@mx.acme-roofing.com>`)}`,
    );
    await pollAndSettle();
    expect(
      (await thread(customer)).rows.find((row) => row.externalMessageId === ours)?.status,
    ).toBe("sent");

    // The bounce of our reply, naming its recipient: the message is marked failed, nothing is
    // answered.
    mail.deliver(
      bounce(ours)
        .replace(/office@acme-roofing\.com/g, mail.address)
        .replace(/nobody@example\.com/g, customer),
    );
    await pollAndSettle();
    const bounced = await thread(customer);
    expect(bounced.rows.find((row) => row.externalMessageId === ours)?.status).toBe("failed");
    expect(bounced.rows.filter((row) => row.direction === "inbound")).toHaveLength(2);
    expect((await thread("MAILER-DAEMON@mx.acme-roofing.com".toLowerCase())).conversations).toEqual(
      [],
    );
  });

  it("stores but never answers mail whose sender failed DMARC at the receiving server (C17)", async () => {
    const victim = `victim.${unique()}@example.com`;
    mail.deliver(
      `Authentication-Results: mx.mail.test; spf=fail smtp.mailfrom=example.com; dmarc=fail (p=REJECT) header.from=example.com\r\n${rawEmail(
        {
          from: victim,
          to: mail.address,
          subject: "Free gift card",
          messageId: `<forged-${unique()}@example.com>`,
          text: "Click https://evil.example/win to claim your prize",
        },
      )}`,
    );
    await pollAndSettle();
    const stored = await thread(victim);
    expect(stored.conversations).toHaveLength(1);
    expect(stored.rows.filter((row) => row.direction === "inbound")).toHaveLength(1);
    expect(stored.rows[0]!.payload).toMatchObject({ metadata: { automated: "dmarc_fail" } });
    // The business's inbox writes nothing to the forged address.
    expect(stored.rows.filter((row) => row.direction === "outbound")).toEqual([]);
  });

  it("never quotes or copies others for an address that has not answered one of our own emails, however often it writes (audit)", async () => {
    // Someone writes "as" a victim's address, twice, with bystanders in Cc. Counting the
    // address's emails proves nothing (the C17 rule quoted the second one): the proof is a
    // reply that names a message we sent to this very address, which a forger never saw.
    await setSettings({ "channels.email.reply_to": "all" });
    try {
      const victim = `victim.${unique()}@example.com`;
      const bystander = `bystander.${unique()}@example.org`;
      const ourReplies = async () =>
        Promise.all(
          (await thread(victim)).rows
            .filter((row) => row.direction === "outbound")
            .map(async (row) => {
              const raw = mail
                .messages("INBOX")
                .find((message) => message.raw.includes(row.externalMessageId!))!;
              return parseEmail(raw.raw);
            }),
        );
      // A message of ours to somebody else: its id is known to that somebody, not proof here.
      const [elsewhere] = await t.admin
        .select({ id: messages.externalMessageId })
        .from(messages)
        .where(
          and(
            eq(messages.businessId, tenant.businessId),
            eq(messages.direction, "outbound"),
            eq(messages.channelConnectionId, connectionId as never),
          ),
        )
        .limit(1);
      expect(elsewhere?.id).toBeTruthy();

      const forged = (text: string, extra: Partial<Parameters<typeof rawEmail>[0]> = {}) =>
        rawEmail({
          from: victim,
          to: mail.address,
          cc: bystander,
          subject: `Quote ${unique()}`,
          messageId: `<forged-${unique()}@example.com>`,
          text,
          ...extra,
        });
      mail.deliver(forged("FIRST attacker text: visit evil.example"));
      await pollAndSettle();
      mail.deliver(forged("SECOND attacker text: visit evil.example"));
      await pollAndSettle();
      mail.deliver(
        forged("THIRD attacker text: visit evil.example", {
          inReplyTo: elsewhere!.id!,
          references: elsewhere!.id!,
        }),
      );
      await pollAndSettle();
      const unproven = await ourReplies();
      expect(unproven.length).toBeGreaterThanOrEqual(2);
      for (const reply of unproven) {
        expect(reply.text).not.toContain("attacker text");
        expect(reply.html ?? "").not.toContain("gmail_quote");
        expect(reply.to.map((item) => item.address)).toEqual([victim]);
        expect(reply.cc).toEqual([]);
      }

      // The real person answers one of our emails: now they are quoted and theirs are copied.
      const ours = unproven[0]!;
      mail.deliver(
        forged("Yes please, Tuesday works for both of us.", {
          subject: `Re: ${ours.subject}`,
          inReplyTo: ours.messageId!,
          references: ours.messageId!,
        }),
      );
      await pollAndSettle();
      const proven = (await ourReplies()).at(-1)!;
      expect(proven.inReplyTo).not.toBe(ours.inReplyTo);
      expect(proven.text).toContain("> Yes please, Tuesday works for both of us.");
      expect(proven.cc.map((item) => item.address)).toEqual([bystander]);
    } finally {
      await setSettings({ "channels.email.reply_to": "sender" });
    }
  });

  it("stops after the daily reply limit of a thread (two auto-responders)", async () => {
    await setSettings({ "channels.email.max_replies_per_thread_per_day": 2 });
    const robot = `helpdesk.${unique()}@example.org`;
    let last = `<r0-${unique()}@example.org>`;
    let references = last;
    mail.deliver(
      rawEmail({
        from: robot,
        to: mail.address,
        messageId: last,
        subject: "Ticket received",
        text: "We got your message, what else can we do?",
      }),
    );
    await pollAndSettle();
    for (let round = 1; round <= 3; round += 1) {
      const outbound = (await thread(robot)).rows.filter((row) => row.direction === "outbound");
      const ours = outbound.at(-1)!.externalMessageId!;
      references = `${references} ${ours}`;
      last = `<r${round}-${unique()}@example.org>`;
      mail.deliver(
        rawEmail({
          from: robot,
          to: mail.address,
          messageId: last,
          inReplyTo: ours,
          references,
          subject: "Re: Ticket received",
          text: "Thanks! What else can we do?",
        }),
      );
      await pollAndSettle();
    }
    const outbound = (await thread(robot)).rows.filter(
      (row) => row.direction === "outbound" && row.author === "bot",
    );
    expect(outbound).toHaveLength(2);
    await setSettings({ "channels.email.max_replies_per_thread_per_day": 8 });
  });

  it("stops a correspondent that starts a new thread with every email (contact limit)", async () => {
    await setSettings({ "channels.email.max_replies_per_thread_per_day": 1 });
    try {
      const robot = `ticketbot.${unique()}@example.org`;
      for (let round = 0; round < 4; round += 1) {
        // No In-Reply-To or References: every email is a thread of its own.
        mail.deliver(
          rawEmail({
            from: robot,
            to: mail.address,
            messageId: `<nt${round}-${unique()}@example.org>`,
            subject: `Your request ${round}`,
            text: "Thank you for your email. What else can we help you with today?",
          }),
        );
        await pollAndSettle();
      }
      const all = await thread(robot);
      expect(all.conversations).toHaveLength(4);
      // Twice the per-thread limit across all its threads in 24 hours.
      expect(all.rows.filter((row) => row.author === "bot")).toHaveLength(2);
    } finally {
      await setSettings({ "channels.email.max_replies_per_thread_per_day": 8 });
    }
  });

  it("hands over when a person at the business replies from the mailbox", async () => {
    const customer = `sam.${unique()}@example.com`;
    const firstId = `<h-${unique()}@example.com>`;
    mail.deliver(
      rawEmail({ from: customer, to: mail.address, messageId: firstId, subject: "Siding" }),
    );
    await pollAndSettle();
    const replies = (await thread(customer)).rows.filter((row) => row.direction === "outbound");
    expect(replies).toHaveLength(1);
    // The owner answers from their mail program; it lands in Sent.
    const personId = `<person-${unique()}@acme-roofing.com>`;
    mail.deliver(
      rawEmail({
        from: `Dave <${mail.address}>`,
        to: customer,
        messageId: personId,
        inReplyTo: firstId,
        references: `${firstId} ${replies[0]!.externalMessageId!}`,
        subject: "Re: Siding",
        text: "Hi, this is Dave, the owner. I'll call you this afternoon.",
      }),
      "Sent",
    );
    await pollAndSettle();
    const after = await thread(customer);
    expect(after.rows.find((row) => row.externalMessageId === personId)).toMatchObject({
      author: "human_agent",
      direction: "outbound",
      payload: { source: "provider_inbox" },
    });
    const [lock] = await t.admin
      .select()
      .from(takeoverLocks)
      .where(eq(takeoverLocks.conversationId, after.conversations[0]!.id));
    expect(lock?.source).toBe("provider_inbox");
    // The customer's next email is stored but the bot stays out.
    mail.deliver(
      rawEmail({
        from: customer,
        to: mail.address,
        messageId: `<h2-${unique()}@example.com>`,
        inReplyTo: personId,
        references: `${firstId} ${personId}`,
        subject: "Re: Siding",
        text: "Great, thanks Dave.",
      }),
    );
    await pollAndSettle();
    const last = await thread(customer);
    expect(last.rows.filter((row) => row.direction === "inbound")).toHaveLength(2);
    expect(last.rows.filter((row) => row.author === "bot")).toHaveLength(1);
  });

  it("never hands over on a forged 'From: the business' in the INBOX", async () => {
    const customer = `forge.${unique()}@example.com`;
    const firstId = `<f-${unique()}@example.com>`;
    mail.deliver(
      rawEmail({
        from: customer,
        to: mail.address,
        messageId: firstId,
        subject: "Deck repair",
        text: "Hi, I need a few rotten deck boards replaced. When could you come by?",
      }),
    );
    await pollAndSettle();
    const replies = (await thread(customer)).rows.filter((row) => row.author === "bot");
    expect(replies).toHaveLength(1);
    // A stranger who knows the thread writes "from" the business, to the customer, into the
    // INBOX: From is not authenticated, so this is neither an answer nor a hand-over.
    mail.deliver(
      rawEmail({
        from: `Dave <${mail.address}>`,
        to: customer,
        messageId: `<forged-${unique()}@evil.example>`,
        inReplyTo: firstId,
        references: `${firstId} ${replies[0]!.externalMessageId!}`,
        subject: "Re: Deck repair",
        text: "This is Dave, I'll take it from here.",
      }),
    );
    await pollAndSettle();
    const after = await thread(customer);
    expect(after.rows.filter((row) => row.author === "human_agent")).toEqual([]);
    expect(
      await t.admin
        .select()
        .from(takeoverLocks)
        .where(eq(takeoverLocks.conversationId, after.conversations[0]!.id)),
    ).toEqual([]);
    // The bot still answers the customer's next email in the thread.
    mail.deliver(
      rawEmail({
        from: customer,
        to: mail.address,
        messageId: `<f2-${unique()}@example.com>`,
        inReplyTo: replies[0]!.externalMessageId!,
        references: `${firstId} ${replies[0]!.externalMessageId!}`,
        subject: "Re: Deck repair",
        text: "Any day next week works for me, mornings are best.",
      }),
    );
    await pollAndSettle();
    expect((await thread(customer)).rows.filter((row) => row.author === "bot")).toHaveLength(2);
  });

  it("copies only the sender by default, never the others the customer copied", async () => {
    const customer = `cc.${unique()}@example.com`;
    const before = mail.messages("INBOX").length;
    mail.deliver(
      rawEmail({
        from: customer,
        to: `${mail.address}, other-roofer@competitor.example`,
        cc: "neighbor@example.net",
        messageId: `<cc-${unique()}@example.com>`,
        subject: "Quotes for a new roof",
        text: "Hi all, I'm collecting quotes for a new roof on a 2,000 sq ft house.",
      }),
    );
    await pollAndSettle();
    const [reply] = (await thread(customer)).rows.filter((row) => row.author === "bot");
    const raw = mail
      .messages("INBOX")
      .slice(before)
      .find((message) => message.raw.includes(reply!.externalMessageId!));
    const parsed = await parseEmail(raw!.raw);
    expect(parsed.to.map((item) => item.address)).toEqual([customer]);
    expect(parsed.cc).toEqual([]);
  });

  it("is read by the minute poll only while connected", async () => {
    await server.email.connections.disconnect(tenant, connectionId as never);
    const customer = `late.${unique()}@example.com`;
    mail.deliver(
      rawEmail({ from: customer, to: mail.address, messageId: `<late-${unique()}@example.com>` }),
    );
    await pollAndSettle();
    expect((await thread(customer)).conversations).toEqual([]);
  });
});

describe("Gmail: OAuth through the routes, push, a threaded reply and a person's reply", () => {
  it("connects through the start and callback routes, bound to the browser and the person", async () => {
    const start = createOAuthStartHandler(routeDeps());
    const response = await start(
      new Request(`${APP_URL}/api/oauth/email/google`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: APP_URL },
        body: JSON.stringify({ businessId: tenant.businessId, returnTo: "/admin/channels/email" }),
      }),
      "google",
    );
    expect(response.status).toBe(200);
    const { authorizationUrl } = (await response.json()) as { authorizationUrl: string };
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toMatch(
      /^hsrb_email_oauth=[^;]+; Path=\/api\/oauth\/email; Max-Age=600; HttpOnly; SameSite=Lax; Secure$/,
    );
    const state = new URL(authorizationUrl).searchParams.get("state")!;
    const cookieValue = cookie.split(";")[0]!.split("=").slice(1).join("=");
    const callback = createOAuthCallbackHandler(routeDeps());
    const back = (query: string, withCookie = true, deps = routeDeps()) =>
      createOAuthCallbackHandler(deps)(
        new Request(`${APP_URL}/api/oauth/email/google/callback?${query}`, {
          headers: withCookie ? { cookie: `other=1; hsrb_email_oauth=${cookieValue}` } : {},
        }),
        "google",
      );
    // Without the cookie of the browser that started it, or as another person: refused.
    expect(
      (await back(`code=good&state=${encodeURIComponent(state)}`, false)).headers.get("location"),
    ).toBe("/?email=invalid_state");
    const otherPerson = {
      ...routeDeps(),
      getAccess: async () => ({
        ...session(),
        user: { id: "00000000-0000-4000-8000-000000000001" as UserId, email: null },
      }),
    };
    expect(
      (await back(`code=good&state=${encodeURIComponent(state)}`, true, otherPerson)).headers.get(
        "location",
      ),
    ).toBe("/admin/channels/email?email=signed_out");
    expect(
      (await back(`error=access_denied&state=${encodeURIComponent(state)}`)).headers.get(
        "location",
      ),
    ).toBe("/admin/channels/email?email=cancelled");

    const done = await callback(
      new Request(
        `${APP_URL}/api/oauth/email/google/callback?code=good&state=${encodeURIComponent(state)}`,
        {
          headers: { cookie: `hsrb_email_oauth=${cookieValue}` },
        },
      ),
      "google",
    );
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/admin/channels/email?email=connected");
    expect(done.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(gmail.watch).not.toBeNull();
    const list = await server.email.connections.list(tenant);
    expect(list.find((item) => item.address === gmail.address)).toMatchObject({
      provider: "gmail",
      status: "active",
      delivery: "push",
    });
  });

  it("answers in the Gmail thread after a Pub/Sub push, and steps back when a person replies from Gmail", async () => {
    const customer = `jo.${unique()}@example.com`;
    const firstId = `<g-${unique()}@mail.gmail.com>`;
    const gmailId = gmail.deliver(
      rawEmail({
        from: `Jo <${customer}>`,
        to: gmail.address,
        messageId: firstId,
        subject: "Furnace not working",
      }),
    );
    const push = () =>
      handleNotification(
        new Request(`${APP_URL}/api/webhooks/email/gmail`, {
          method: "POST",
          headers: { authorization: `Bearer ${pushToken()}`, "content-type": "application/json" },
          body: JSON.stringify({
            message: {
              data: Buffer.from(
                JSON.stringify({ emailAddress: gmail.address, historyId: gmail.historyId() }),
              ).toString("base64"),
              messageId: unique(),
            },
            subscription: "projects/acme/subscriptions/gmail",
          }),
        }),
        server.email.gmailPush,
        quiet,
      );
    expect((await push()).status).toBe(204);
    await runner.idle();
    const first = await thread(customer);
    expect(first.conversations[0]!.thread).toBe(`gmail:${gmailId}`);
    const replies = first.rows.filter((row) => row.direction === "outbound");
    expect(replies).toHaveLength(1);
    const sent = gmail.sent.at(-1)!;
    expect(sent.threadId).toBe(gmailId);
    const parsed = await parseEmail(sent.raw);
    expect(parsed.messageId).toBe(replies[0]!.externalMessageId);
    expect(parsed.inReplyTo).toBe(firstId);
    expect(parsed.subject).toBe("Re: Furnace not working");

    // The owner replies from Gmail's web app: SENT, same thread, not our marker.
    const personId = `<CAperson-${unique()}@mail.gmail.com>`;
    gmail.deliver(
      rawEmail({
        from: `Acme <${gmail.address}>`,
        to: customer,
        messageId: personId,
        inReplyTo: firstId,
        references: firstId,
        subject: "Re: Furnace not working",
        text: "Jo, we can come at 2pm today.",
      }),
      { label: "SENT", threadId: gmailId },
    );
    expect((await push()).status).toBe(204);
    await runner.idle();
    const after = await thread(customer);
    expect(after.rows.find((row) => row.externalMessageId === personId)).toMatchObject({
      author: "human_agent",
    });
    expect(
      await t.admin
        .select()
        .from(takeoverLocks)
        .where(eq(takeoverLocks.conversationId, after.conversations[0]!.id)),
    ).toHaveLength(1);
    // Our own reply in SENT was recognized as ours and never handed the thread over.
    expect(after.rows.filter((row) => row.author === "human_agent")).toHaveLength(1);
  });

  it("recognizes its own sent copy when Gmail rewrote the Message-ID and dropped the loop header", async () => {
    gmail.rewriteSentHeaders = true;
    try {
      const customer = `rw.${unique()}@example.com`;
      const firstId = `<rw-${unique()}@mail.gmail.com>`;
      gmail.deliver(
        rawEmail({
          from: `Robin <${customer}>`,
          to: gmail.address,
          messageId: firstId,
          subject: "Water heater",
          text: "Hi, my water heater makes a banging noise. Could someone look at it this week?",
        }),
      );
      const push = () =>
        handleNotification(
          new Request(`${APP_URL}/api/webhooks/email/gmail`, {
            method: "POST",
            headers: { authorization: `Bearer ${pushToken()}`, "content-type": "application/json" },
            body: JSON.stringify({
              message: {
                data: Buffer.from(
                  JSON.stringify({ emailAddress: gmail.address, historyId: gmail.historyId() }),
                ).toString("base64"),
                messageId: unique(),
              },
            }),
          }),
          server.email.gmailPush,
          quiet,
        );
      expect((await push()).status).toBe(204);
      await runner.idle();
      expect((await thread(customer)).rows.filter((row) => row.author === "bot")).toHaveLength(1);
      // What we sent carries the loop header; the copy Gmail keeps in SENT does not.
      const copy = await parseEmail(gmail.sent.at(-1)!.raw);
      expect(copy.headers.has("x-hsrb-loop")).toBe(true);
      // The next sync reads that copy: it is ours (Gmail's id from the send), not a person's.
      expect((await push()).status).toBe(204);
      await runner.idle();
      const after = await thread(customer);
      expect(after.rows.filter((row) => row.author === "human_agent")).toEqual([]);
      expect(
        await t.admin
          .select()
          .from(takeoverLocks)
          .where(eq(takeoverLocks.conversationId, after.conversations[0]!.id)),
      ).toEqual([]);
    } finally {
      gmail.rewriteSentHeaders = false;
    }
  });

  it("ignores a Gmail out-of-office answer and a newsletter, and marks a bounced reply failed", async () => {
    const customer = `ooo.${unique()}@example.com`;
    const firstId = `<o-${unique()}@mail.gmail.com>`;
    gmail.deliver(
      rawEmail({
        from: customer,
        to: gmail.address,
        messageId: firstId,
        subject: "Leaking skylight",
      }),
    );
    const push = async () => {
      const response = await handleNotification(
        new Request(`${APP_URL}/api/webhooks/email/gmail`, {
          method: "POST",
          headers: { authorization: `Bearer ${pushToken()}`, "content-type": "application/json" },
          body: JSON.stringify({
            message: {
              data: Buffer.from(
                JSON.stringify({ emailAddress: gmail.address, historyId: gmail.historyId() }),
              ).toString("base64"),
              messageId: unique(),
            },
          }),
        }),
        server.email.gmailPush,
        quiet,
      );
      expect(response.status).toBe(204);
      await runner.idle();
    };
    await push();
    const ours = (await thread(customer)).rows.find(
      (row) => row.direction === "outbound",
    )!.externalMessageId!;
    gmail.deliver(
      outOfOffice(ours)
        .replace(/maria\.lopez@example\.com/g, customer)
        .replace("<oof-1@example.com>", `<oof-${unique()}@example.com>`),
    );
    gmail.deliver(newsletter());
    gmail.deliver(
      bounce(ours)
        .replace(/office@acme-roofing\.com/g, gmail.address)
        .replace(/nobody@example\.com/g, customer),
    );
    await push();
    const after = await thread(customer);
    expect(after.rows.filter((row) => row.author === "bot")).toHaveLength(1);
    expect(after.rows.find((row) => row.externalMessageId === ours)?.status).toBe("failed");
    expect(after.rows.filter((row) => row.direction === "inbound").at(-1)?.payload).toMatchObject({
      metadata: { automated: "auto_reply" },
    });
  });

  it("refuses a push without Google's token", async () => {
    const response = await handleNotification(
      new Request(`${APP_URL}/api/webhooks/email/gmail`, { method: "POST", body: "{}" }),
      server.email.gmailPush,
      quiet,
    );
    expect(response.status).toBe(401);
  });
});

describe("Microsoft 365: OAuth, change notifications and a threaded reply", () => {
  it("connects, answers Graph's handshake, and replies in the thread after a notification", async () => {
    const start = await createOAuthStartHandler(routeDeps())(
      new Request(`${APP_URL}/api/oauth/email/microsoft`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: APP_URL },
        body: JSON.stringify({ businessId: tenant.businessId }),
      }),
      "microsoft",
    );
    const { authorizationUrl } = (await start.json()) as { authorizationUrl: string };
    expect(
      authorizationUrl.startsWith(
        "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?",
      ),
    ).toBe(true);
    const cookieValue = start.headers
      .get("set-cookie")!
      .split(";")[0]!
      .split("=")
      .slice(1)
      .join("=");
    const state = new URL(authorizationUrl).searchParams.get("state")!;
    // A state from the Microsoft flow is refused on the Google callback.
    const wrong = await createOAuthCallbackHandler(routeDeps())(
      new Request(
        `${APP_URL}/api/oauth/email/google/callback?code=x&state=${encodeURIComponent(state)}`,
        { headers: { cookie: `hsrb_email_oauth=${cookieValue}` } },
      ),
      "google",
    );
    expect(wrong.headers.get("location")).toBe("/?email=invalid_state");
    const done = await createOAuthCallbackHandler(routeDeps())(
      new Request(
        `${APP_URL}/api/oauth/email/microsoft/callback?code=x&state=${encodeURIComponent(state)}`,
        { headers: { cookie: `hsrb_email_oauth=${cookieValue}` } },
      ),
      "microsoft",
    );
    expect(done.headers.get("location")).toBe("/?email=connected");
    const [connection] = await t.admin
      .select()
      .from(channelConnections)
      .where(eq(channelConnections.externalAccountId, graph.address));
    const subscriptionId = (connection!.state as { subscriptionId: string }).subscriptionId;
    expect(graph.subscriptions.get(subscriptionId)?.notificationUrl).toBe(
      `${APP_URL}/api/webhooks/email/microsoft`,
    );

    const notify = (body: string, query = "") =>
      handleNotification(
        new Request(`${APP_URL}/api/webhooks/email/microsoft${query}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
        server.email.graphNotifications,
        quiet,
      );
    const handshake = await notify("", "?validationToken=abc%20123");
    expect(handshake.status).toBe(200);
    expect(handshake.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await handshake.text()).toBe("abc 123");

    const customer = `lee.${unique()}@example.com`;
    const firstId = `<m-${unique()}@outlook.example>`;
    await graph.deliver(
      rawEmail({
        from: `Lee <${customer}>`,
        to: graph.address,
        messageId: firstId,
        subject: "New panel",
      }),
      { conversationId: "AAQkLee" },
    );
    const notification = (clientState: string) =>
      JSON.stringify({
        value: [
          {
            subscriptionId,
            clientState,
            changeType: "created",
            resource: "Users/u/Messages/m",
            tenantId: "t",
          },
        ],
      });
    expect((await notify(notification("forged"))).status).toBe(401);
    await runner.idle();
    expect((await thread(customer)).conversations).toEqual([]);
    expect(
      (await notify(notification(graphClientState(CLIENT_STATE_SECRET, connection!.id)))).status,
    ).toBe(202);
    await runner.idle();
    const after = await thread(customer);
    expect(after.conversations[0]!.thread).toBe("graph:AAQkLee");
    const reply = after.rows.find((row) => row.direction === "outbound")!;
    expect(reply.status).toBe("sent");
    const sent = await parseEmail(graph.sent.at(-1)!);
    expect(sent.messageId).toBe(reply.externalMessageId);
    expect(sent.inReplyTo).toBe(firstId);

    // An out-of-office answer in the thread and a newsletter: no reply.
    await graph.deliver(
      outOfOffice(reply.externalMessageId!)
        .replace(/maria\.lopez@example\.com/g, customer)
        .replace("<oof-1@example.com>", `<oof-${unique()}@example.com>`),
      { conversationId: "AAQkLee" },
    );
    await graph.deliver(newsletter());
    expect(
      (await notify(notification(graphClientState(CLIENT_STATE_SECRET, connection!.id)))).status,
    ).toBe(202);
    await runner.idle();
    const last = await thread(customer);
    expect(last.rows.filter((row) => row.author === "bot")).toHaveLength(1);
    expect(last.rows.filter((row) => row.direction === "inbound")).toHaveLength(2);

    // Exchange rewrote our Message-ID and dropped the loop header on the copy in Sent Items,
    // and Graph's sendMail returns no id: the copy is still recognized as ours by its words.
    graph.rewriteSentHeaders = true;
    try {
      const other = `kim.${unique()}@example.com`;
      await graph.deliver(
        rawEmail({
          from: `Kim <${other}>`,
          to: graph.address,
          messageId: `<k-${unique()}@outlook.example>`,
          subject: "Outlet sparks",
          text: "Hello, an outlet in my garage sparks when I plug things in. Can you help?",
        }),
        { conversationId: "AAQkKim" },
      );
      const valid = notification(graphClientState(CLIENT_STATE_SECRET, connection!.id));
      expect((await notify(valid)).status).toBe(202);
      await runner.idle();
      expect((await thread(other)).rows.filter((row) => row.author === "bot")).toHaveLength(1);
      expect((await notify(valid)).status).toBe(202);
      await runner.idle();
      const kim = await thread(other);
      expect(kim.rows.filter((row) => row.author === "human_agent")).toEqual([]);
      expect(
        await t.admin
          .select()
          .from(takeoverLocks)
          .where(eq(takeoverLocks.conversationId, kim.conversations[0]!.id)),
      ).toEqual([]);
    } finally {
      graph.rewriteSentHeaders = false;
    }
  });
});
