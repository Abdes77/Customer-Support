import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type BusinessId,
  type ChannelConnectionContext,
  type ChannelConnectionId,
  type ConversationId,
  createLogger,
  type SendTarget,
} from "@repo/core";

import { createEmailAdapter } from "./adapter";
import type { EmailConnectionConfig, EmailCredentials } from "./config";
import { parseEmail } from "./mime/parse";
import { createGmailClient } from "./providers/gmail";
import { MailServerError, checkImap, checkSmtp, openImap } from "./providers/imap";
import { createGraphMailClient } from "./providers/microsoft";
import { createFakeGmail } from "./testing/fake-gmail";
import { createFakeGraph } from "./testing/fake-graph";
import { CUSTOMER, INBOX, rawEmail } from "./testing/fixtures";
import { type LocalMailServer, startLocalMailServer } from "./testing/mail-server";

const logger = createLogger({ level: "error" });
const LOOP = "loop-token-for-tests-123";

function target(
  config: EmailConnectionConfig,
  credentials: EmailCredentials,
  overrides: Partial<SendTarget> = {},
): SendTarget {
  const connection: ChannelConnectionContext = {
    connectionId: "6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" as ChannelConnectionId,
    businessId: "9a1c3e5f-2b4d-4f6a-8c0e-1d3f5a7b9c03" as BusinessId,
    externalAccountId: INBOX,
    credentials,
    config,
  };
  return {
    connection,
    conversationId: "5d7f9b1c-3e5a-4c7e-9a1b-2c4e6f8a0b04" as ConversationId,
    recipientExternalId: CUSTOMER,
    externalThreadId: "gmail:18c0000000000001",
    replyToExternalMessageId: "<m1@mail.gmail.com>",
    window: { open: true, closesAt: null },
    email: {
      inReplyTo: "<m1@mail.gmail.com>",
      references: ["<m0@x>", "<m1@mail.gmail.com>"],
      subject: "Re: Roof leak",
    },
    idempotencyKey: "2d4f6b8c-0e2a-4c4e-b6a8-7b9d1f3a5c07:0",
    sentByHuman: false,
    ...overrides,
  };
}

const oauth: EmailCredentials = {
  kind: "oauth",
  accessToken: "gmail-access-1",
  refreshToken: "gmail-refresh-1",
  expiresAt: "2099-01-01T00:00:00.000Z",
  scope: "",
};
const gmailConfig: EmailConnectionConfig = {
  provider: "gmail",
  address: INBOX,
  displayName: null,
  loopToken: LOOP,
};

describe("email adapter: Gmail", () => {
  it("sends one MIME email in the customer's thread, with our Message-ID", async () => {
    const gmail = createFakeGmail();
    const adapter = createEmailAdapter({
      accessToken: async (connection) =>
        (connection.credentials as { accessToken: string }).accessToken,
      gmail: createGmailClient(gmail.fetch),
      graph: createGraphMailClient(gmail.fetch),
      logger,
      clock: () => new Date("2026-11-11T21:00:00Z"),
    });
    const result = await adapter.send(
      {
        kind: "email",
        subject: "Re: Roof leak",
        text: "Hi Maria,\n\nThursday at 9 works.\n\nBest,\nSam",
        html: "<div>Hi Maria,</div>",
        cc: [
          { address: "bob@example.com", name: "Bob" },
          { address: INBOX, name: null },
          { address: CUSTOMER, name: null },
        ],
        fromName: "Sam at Acme Roofing",
      },
      target(gmailConfig, oauth),
    );
    expect(result.ok).toBe(true);
    expect(gmail.sent).toHaveLength(1);
    expect(gmail.sent[0]!.threadId).toBe("18c0000000000001");
    const sent = await parseEmail(gmail.sent[0]!.raw);
    expect(result.ok && result.externalMessageId).toBe(sent.messageId);
    expect(sent.messageId).toMatch(/@acme-roofing\.com>$/);
    expect(sent.from).toEqual({ address: INBOX, name: "Sam at Acme Roofing" });
    expect(sent.to.map((item) => item.address)).toEqual([CUSTOMER]);
    expect(sent.cc.map((item) => item.address)).toEqual(["bob@example.com"]);
    expect(sent.inReplyTo).toBe("<m1@mail.gmail.com>");
    expect(sent.references).toEqual(["<m0@x>", "<m1@mail.gmail.com>"]);
    expect(sent.subject).toBe("Re: Roof leak");
    expect(sent.headers.get("x-hsrb-loop")).toEqual([LOOP]);
    expect(sent.html).toContain("Hi Maria");
    // A retried send carries the same id.
    const again = await adapter.send({ kind: "text", text: "Hi" }, target(gmailConfig, oauth));
    expect(again.ok && again.externalMessageId).toBe(sent.messageId);
  });

  it("reports refused tokens, rate limits and bad recipients as the pipeline expects", async () => {
    const gmail = createFakeGmail();
    gmail.revoked = true;
    const adapter = createEmailAdapter({
      accessToken: async () => "gmail-access-1",
      gmail: createGmailClient(gmail.fetch),
      graph: createGraphMailClient(gmail.fetch),
      logger,
    });
    const refused = await adapter.send({ kind: "text", text: "Hi" }, target(gmailConfig, oauth));
    expect(refused).toMatchObject({ ok: false, error: { code: "auth_failed", retryable: false } });

    const limited = createEmailAdapter({
      accessToken: async () => "t",
      gmail: createGmailClient(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: 429, message: "Too many", status: "RESOURCE_EXHAUSTED" },
            }),
            {
              status: 429,
              headers: { "retry-after": "30" },
            },
          ),
      ),
      graph: createGraphMailClient(gmail.fetch),
      logger,
    });
    expect(
      await limited.send({ kind: "text", text: "Hi" }, target(gmailConfig, oauth)),
    ).toMatchObject({
      ok: false,
      error: { retryable: true, retryAfterSeconds: 30, windowClosed: false },
    });
    expect(
      await limited.send(
        { kind: "text", text: "Hi" },
        target(gmailConfig, oauth, { recipientExternalId: "not an address" }),
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid_recipient", retryable: false } });
    expect(
      await limited.send(
        { kind: "template", templateName: "x", languageCode: "en_US", variables: [] },
        target(gmailConfig, oauth),
      ),
    ).toMatchObject({ ok: false, error: { code: "unsupported" } });
  });

  it("has no generic webhook", async () => {
    const adapter = createEmailAdapter({
      accessToken: async () => "t",
      gmail: createGmailClient(fetch),
      graph: createGraphMailClient(fetch),
      logger,
    });
    expect(
      await adapter.verifyWebhook({
        method: "POST",
        url: "https://x/api/webhooks/email",
        headers: {},
        query: {},
        rawBody: "{}",
      }),
    ).toMatchObject({
      outcome: "rejected",
    });
    await expect(
      adapter.parseWebhook({
        method: "POST",
        url: "https://x",
        headers: {},
        query: {},
        rawBody: "{}",
      }),
    ).rejects.toThrow();
  });
});

describe("email adapter: Microsoft Graph", () => {
  it("sends the MIME message base64-encoded as text/plain", async () => {
    const graph = createFakeGraph();
    const adapter = createEmailAdapter({
      accessToken: async () => "graph-access-1",
      gmail: createGmailClient(graph.fetch),
      graph: createGraphMailClient(graph.fetch),
      logger,
    });
    const result = await adapter.send(
      { kind: "email", subject: "Re: Roof leak", text: "Hello", html: "<div>Hello</div>" },
      target(
        { provider: "microsoft", address: INBOX, displayName: null, loopToken: LOOP, userId: "u1" },
        { ...oauth, accessToken: "graph-access-1" },
        {
          externalThreadId: "graph:AAQkConv1",
        },
      ),
    );
    expect(result.ok).toBe(true);
    const sent = await parseEmail(graph.sent[0]!);
    expect(result.ok && result.externalMessageId).toBe(sent.messageId);
    expect(sent.inReplyTo).toBe("<m1@mail.gmail.com>");
  });
});

describe("IMAP and SMTP against a local mail server", () => {
  let server: LocalMailServer;
  beforeAll(async () => {
    server = await startLocalMailServer();
  });
  afterAll(async () => {
    await server.stop();
  });

  it("logs in over TLS, finds the Sent folder and reads new messages read-only", async () => {
    const checked = await checkImap(server.imap, server.password, server.policy);
    expect(checked.sentFolder).toBe("Sent");
    server.deliver(rawEmail());
    server.deliver(rawEmail({ messageId: "<second@example.com>" }));
    const session = await openImap(server.imap, server.password, server.policy);
    try {
      const box = await session.open("INBOX");
      const after = box.uidNext - 3;
      const messages = await session.fetchAfter(after, 10);
      expect(messages.map((message) => message.uid)).toEqual([after + 1, after + 2]);
      expect((await parseEmail(messages[1]!.source!)).messageId).toBe("<second@example.com>");
      expect(await session.fetchAfter(box.uidNext - 1, 10)).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it("refuses a wrong password as an authentication failure", async () => {
    const error = await checkSmtp(server.smtp, "wrong", server.policy)
      .then(() => null)
      .catch((caught: unknown) => caught);
    // ImapKit's SMTP accepts any password: the IMAP login is the one that refuses.
    expect(error).toBeNull();
    const imapError = await checkImap(server.imap, "wrong", server.policy).catch(
      (caught: unknown) => caught,
    );
    expect(imapError).toBeInstanceOf(MailServerError);
    expect((imapError as MailServerError).authFailed).toBe(true);
  });

  it("verifies the server's certificate (an untrusted one fails before the login)", async () => {
    const { ca: _trusted, ...untrusted } = server.policy;
    const error = await checkImap(server.imap, server.password, untrusted).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(MailServerError);
    expect((error as MailServerError).authFailed).toBe(false);
    await expect(checkSmtp(server.smtp, server.password, untrusted)).rejects.toBeInstanceOf(
      MailServerError,
    );
  });

  it("refuses the local server under the production address rules (SSRF)", async () => {
    await expect(checkImap(server.imap, server.password)).rejects.toThrow(
      /standard IMAP port|public internet/,
    );
  });

  it("sends by SMTP with STARTTLS and copies the email into Sent", async () => {
    const adapter = createEmailAdapter({
      accessToken: async () => "unused",
      gmail: createGmailClient(fetch),
      graph: createGraphMailClient(fetch),
      mailPolicy: server.policy,
      logger,
    });
    const before = server.messages("INBOX").length;
    const result = await adapter.send(
      {
        kind: "email",
        subject: "Re: Roof leak",
        text: "Hi Maria",
        html: "<div>Hi Maria</div>",
        fromName: "Sam",
      },
      target(
        {
          provider: "imap",
          address: server.address,
          displayName: null,
          loopToken: LOOP,
          imap: server.imap,
          smtp: server.smtp,
          sentFolder: "Sent",
          appendSent: true,
        },
        { kind: "password", imapPassword: server.password, smtpPassword: server.password },
      ),
    );
    expect(result).toMatchObject({ ok: true });
    // ImapKit's SMTP listener delivers what it accepts into the INBOX.
    const delivered = server.messages("INBOX").slice(before);
    expect(delivered).toHaveLength(1);
    const parsed = await parseEmail(delivered[0]!.raw);
    expect(parsed.messageId).toBe(result.ok ? result.externalMessageId : null);
    expect(parsed.inReplyTo).toBe("<m1@mail.gmail.com>");
    expect(server.messages("Sent").some((message) => message.raw.includes(parsed.messageId!))).toBe(
      true,
    );
  });
});

describe("Microsoft Graph state links (audit)", () => {
  it("reads a stored delta or next link only from Graph's own host: the token goes nowhere else", async () => {
    const calls: string[] = [];
    const client = createGraphMailClient(async (input) => {
      calls.push(String(input));
      return Response.json({ value: [] });
    });
    for (const link of [
      "https://evil.example/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=x",
      "https://graph.microsoft.com.evil.example/v1.0/me/messages/delta",
      "http://graph.microsoft.com/v1.0/me/messages/delta",
      "https://graph.microsoft.com:8443/v1.0/me/messages/delta",
      "not a url",
    ]) {
      await expect(
        Promise.resolve().then(() => client.deltaNext("graph-token", link)),
      ).rejects.toThrow();
    }
    expect(calls).toEqual([]);
    await client.deltaNext(
      "graph-token",
      "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=abc",
    );
    expect(calls).toHaveLength(1);
  });
});
