import { readFileSync } from "node:fs";

import { expect, type APIRequestContext, type Page, test } from "@playwright/test";

import { parseEmail } from "@repo/channel-email";
import { rawEmail } from "@repo/channel-email/testing";
import { metaSignature } from "@repo/channel-meta";
import {
  and,
  contactIdentities,
  conversations,
  createDatabase,
  desc,
  eq,
  leadReports,
  leads,
  messages,
} from "@repo/db";

import { APP_URL, type E2eState, FAKES_URL, META_APP_SECRET, STATE_FILE } from "./support/config";
import type { GraphCallRecord } from "./support/fakes";

/*
 * The customer journey on every channel that can run on this machine (C18), against a
 * production build: WhatsApp, Messenger and Instagram through correctly signed webhooks and a
 * fake of Meta's Graph API; email through a real IMAP/SMTP server (C11's ImapKit server),
 * connected from the admin panel. The website chat has its own spec (widget.spec.ts) and the
 * test channel is used by inbox.spec.ts and journey.spec.ts.
 *
 * The bot is the offline rule-based stand-in (no Claude API key): these journeys prove the
 * plumbing (inbound, debounce, reply on the right channel, lead scoring and report, the inbox,
 * takeover and a person's reply going out on the customer's channel), not the quality of the
 * replies. They run at desktop width only: they drive the channels through their APIs, and the
 * inbox screens are checked at phone width by inbox.spec.ts.
 */

const state = (): E2eState => JSON.parse(readFileSync(STATE_FILE, "utf8")) as E2eState;
const PASSWORD = "brightline-demo";

test.skip(({ isMobile }) => isMobile, "Channel journeys run once, at desktop width.");

/** What a homeowner with a leaking roof answers to each question the offline bot asks. */
function answerFor(question: string): string {
  const q = question.toLowerCase();
  if (q.includes("zip")) return "The ZIP is 55418.";
  if (q.includes("how soon")) return "As soon as possible, this week if you can.";
  if (q.includes("own the home")) return "Yes, I own the home.";
  if (q.includes("kind of property")) return "It's a single family house.";
  if (q.includes("budget")) return "Somewhere around $12,000 if it needs a new roof.";
  if (q.includes("address")) return "It's 2210 Johnson Street in Minneapolis.";
  if (q.includes("name")) return "I'm Chris Olsen.";
  if (q.includes("phone")) return "You can reach me at 612-555-0187.";
  if (q.includes("email")) return "chris.olsen@example.com";
  if (q.includes("a bit more")) return "Water drips into the upstairs bedroom when it rains.";
  return "Yes.";
}

const DONE = /what the team needs|reach out|be in touch/i;

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto(`${APP_URL}/sign-in`);
  await page.getByLabel("Email").first().fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/businesses"));
}

/** Posts a webhook body signed with the Meta app secret, as Meta does. */
async function postMeta(
  request: APIRequestContext,
  path: string,
  body: Record<string, unknown>,
): Promise<number> {
  const raw = JSON.stringify(body);
  const response = await request.post(`${APP_URL}${path}`, {
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": metaSignature(META_APP_SECRET, raw),
    },
    data: raw,
  });
  return response.status();
}

async function graphCalls(request: APIRequestContext): Promise<GraphCallRecord[]> {
  return (await (await request.get(`${FAKES_URL}/__e2e/graph/calls`)).json()) as GraphCallRecord[];
}

/** The text of a message the app sent through the Graph API (text, buttons or quick replies). */
function sentText(json: Record<string, unknown> | null): string | null {
  if (json === null) return null;
  const text = json["text"];
  if (typeof text === "object" && text !== null && "body" in text) {
    return String(text.body);
  }
  const interactive = json["interactive"] as { body?: { text?: string } } | undefined;
  if (interactive?.body?.text !== undefined) return interactive.body.text;
  const message = json["message"] as { text?: string } | undefined;
  if (typeof message?.text === "string") return message.text;
  return null;
}

/** Messages the app sent to one customer (not read receipts, typing or "seen"). */
async function sentTo(request: APIRequestContext, recipient: string): Promise<string[]> {
  return (await graphCalls(request))
    .filter((call) => call.method === "POST" && call.path.endsWith("/messages"))
    .filter((call) => {
      const json = call.json ?? {};
      // WhatsApp: `to` in E.164 ("+1612..."); Messenger and Instagram: `recipient.id`.
      const to = json["to"] ?? (json["recipient"] as { id?: string } | undefined)?.id;
      return (
        (to === recipient || to === `+${recipient}`) &&
        json["status"] === undefined &&
        json["sender_action"] === undefined
      );
    })
    .map((call) => sentText(call.json))
    .filter((text): text is string => text !== null);
}

/** Waits for the reply number `count` to this customer and returns its text. */
async function nthReply(request: APIRequestContext, recipient: string, count: number) {
  await expect
    .poll(async () => (await sentTo(request, recipient)).length, { timeout: 60_000 })
    .toBeGreaterThanOrEqual(count);
  return (await sentTo(request, recipient))[count - 1]!;
}

async function leadOf(databaseUrl: string, businessId: string, externalId: string) {
  const db = createDatabase({ url: databaseUrl, max: 1, applicationName: "e2e-check" });
  try {
    return await db.forBusiness(businessId as never).run(async (ctx) => {
      const [conversation] = await ctx.tx
        .select({ id: conversations.id, channel: conversations.channel })
        .from(conversations)
        .innerJoin(contactIdentities, eq(contactIdentities.contactId, conversations.contactId))
        .where(eq(contactIdentities.externalId, externalId))
        .orderBy(desc(conversations.createdAt))
        .limit(1);
      if (conversation === undefined) return null;
      const [lead] = await ctx.tx
        .select({ id: leads.id, score: leads.score })
        .from(leads)
        .where(eq(leads.conversationId, conversation.id));
      const reports =
        lead === undefined
          ? []
          : await ctx.tx.select().from(leadReports).where(eq(leadReports.leadId, lead.id));
      const rows = await ctx.tx
        .select({
          direction: messages.direction,
          status: messages.status,
          ext: messages.externalMessageId,
        })
        .from(messages)
        .where(and(eq(messages.conversationId, conversation.id)));
      return { conversation, lead, reports: reports.length, messages: rows };
    });
  } finally {
    await db.close();
  }
}

/** Takes the conversation over in the inbox, replies by hand and releases it. */
async function takeOverAndReply(page: Page, search: string, reply: string, channel: string) {
  await page.goto(`${APP_URL}/inbox`);
  await page.getByRole("searchbox", { name: "Search conversations" }).fill(search);
  await page.getByRole("button", { name: "Filter" }).click();
  const row = page.getByTestId("inbox-row");
  await expect(row).toHaveCount(1);
  await row.getByRole("link").click();
  await page.waitForURL(/\/inbox\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("lead-panel")).toBeVisible();
  await page.getByRole("button", { name: "Take over" }).click();
  await expect(page.getByTestId("takeover-state")).toContainText("You hold this conversation");
  await page.getByRole("textbox", { name: "Reply to the customer" }).fill(reply);
  await page.getByRole("button", { name: "Send reply" }).click();
  await expect(page.getByText(`Sent through ${channel}.`)).toBeVisible();
  await page.getByRole("button", { name: "Release to the bot" }).click();
  await expect(page.getByTestId("takeover-state")).toContainText("The bot is answering");
}

test("WhatsApp: one reply per burst, a qualified lead, statuses, and a person's reply on WhatsApp", async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  const { channels, databaseUrl } = state();
  const tag = Date.now().toString(36);
  const customer = `1612555${String(Date.now()).slice(-4)}`;
  let counter = 0;
  const send = (text: string) => {
    counter += 1;
    return postMeta(request, "/api/webhooks/whatsapp", {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "300000000000002",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "16125550100",
                  phone_number_id: channels.whatsappPhoneNumberId,
                },
                contacts: [{ profile: { name: "Chris Olsen" }, wa_id: customer }],
                messages: [
                  {
                    from: customer,
                    id: `wamid.e2e-${tag}-${counter}`,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: "text",
                    text: { body: text },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
  };

  // A burst of two messages and a repeated delivery of the first: one reply.
  expect(await send(`Hi, my roof is leaking after the storm ${tag}`)).toBe(200);
  expect(await send("Water is coming in around the chimney.")).toBe(200);
  counter = 0;
  expect(await send(`Hi, my roof is leaking after the storm ${tag}`)).toBe(200);
  counter = 2;
  let question = await nthReply(request, customer, 1);
  await page.waitForTimeout(3_000);
  expect(await sentTo(request, customer)).toHaveLength(1);
  // The app marked the customer's messages read on WhatsApp.
  expect(
    (await graphCalls(request)).some(
      (call) => call.json?.["status"] === "read" && call.path.endsWith("/messages"),
    ),
  ).toBe(true);

  // Answer until the bot has what the team needs.
  let replies = 1;
  for (let turn = 0; turn < 10 && !DONE.test(question); turn += 1) {
    expect(await send(answerFor(question))).toBe(200);
    replies += 1;
    question = await nthReply(request, customer, replies);
  }
  expect(question).toMatch(DONE);

  // Delivery and read statuses from Meta move the reply's status.
  const found = await leadOf(databaseUrl, channels.businessId, customer);
  expect(found?.conversation.channel).toBe("whatsapp");
  expect(found?.lead?.score ?? 0).toBeGreaterThan(0);
  expect(found?.reports ?? 0).toBeGreaterThan(0);
  const firstReply = found!.messages.find(
    (row) => row.direction === "outbound" && row.ext !== null,
  );
  expect(
    await postMeta(request, "/api/webhooks/whatsapp", {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "300000000000002",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "16125550100",
                  phone_number_id: channels.whatsappPhoneNumberId,
                },
                statuses: [
                  {
                    id: firstReply!.ext,
                    status: "read",
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    recipient_id: customer,
                  },
                ],
              },
            },
          ],
        },
      ],
    }),
  ).toBe(200);
  await expect
    .poll(async () => {
      const after = await leadOf(databaseUrl, channels.businessId, customer);
      return after?.messages.find((row) => row.ext === firstReply!.ext)?.status;
    })
    .toBe("read");

  // A webhook with a wrong signature is refused.
  const forged = await request.post(`${APP_URL}/api/webhooks/whatsapp`, {
    headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=00" },
    data: JSON.stringify({ object: "whatsapp_business_account", entry: [] }),
  });
  expect(forged.status()).toBe(401);

  // A person at the business takes over and replies: it goes out on WhatsApp.
  await signIn(page, "member@brightline.test");
  const mine = `Hi Chris, this is Morgan from Northside. Tomorrow at 9 works ${tag}`;
  await takeOverAndReply(page, tag, mine, "WhatsApp");
  await expect.poll(async () => sentTo(request, customer)).toContain(mine);
});

for (const platform of ["messenger", "instagram"] as const) {
  test(`${platform === "messenger" ? "Messenger" : "Instagram"}: the bot answers, the lead is scored, and a person's reply goes out on the same platform`, async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);
    const { channels, databaseUrl } = state();
    const tag = `${platform.slice(0, 2)}${Date.now().toString(36)}`;
    const customer = `${platform === "messenger" ? "7" : "8"}${String(Date.now()).slice(-12)}`;
    const account = platform === "messenger" ? channels.pageId : channels.instagramAccountId;
    let counter = 0;
    const send = (text: string) => {
      counter += 1;
      const now = Date.now();
      return postMeta(request, `/api/webhooks/${platform}`, {
        object: platform === "messenger" ? "page" : "instagram",
        entry: [
          {
            id: account,
            time: now,
            messaging: [
              {
                sender: { id: customer },
                recipient: { id: account },
                timestamp: now,
                message: { mid: `m_e2e-${tag}-${counter}`, text },
              },
            ],
          },
        ],
      });
    };

    expect(await send(`Hello, I need my gutters replaced ${tag}`)).toBe(200);
    let question = await nthReply(request, customer, 1);
    let replies = 1;
    for (let turn = 0; turn < 10 && !DONE.test(question); turn += 1) {
      expect(await send(answerFor(question))).toBe(200);
      replies += 1;
      question = await nthReply(request, customer, replies);
    }
    expect(question).toMatch(DONE);
    // The replies were sent with the Page's token.
    expect(
      (await graphCalls(request)).some(
        (call) => call.token === "EAAPage-e2e-token" && call.path.endsWith("/messages"),
      ),
    ).toBe(true);
    const found = await leadOf(databaseUrl, channels.businessId, customer);
    expect(found?.conversation.channel).toBe(platform);
    expect(found?.lead?.score ?? 0).toBeGreaterThan(0);
    expect(found?.reports ?? 0).toBeGreaterThan(0);

    await signIn(page, "member@brightline.test");
    const mine = `Thanks! Morgan from Northside here, I'll call you today ${tag}`;
    await takeOverAndReply(page, tag, mine, platform === "messenger" ? "Messenger" : "Instagram");
    await expect.poll(async () => sentTo(request, customer)).toContain(mine);
  });
}

async function mailbox(request: APIRequestContext): Promise<{ uid: number; raw: string }[]> {
  return (await (await request.get(`${FAKES_URL}/__e2e/mail/messages?folder=INBOX`)).json()) as {
    uid: number;
    raw: string;
  }[];
}

test("email: an IMAP/SMTP inbox connected in the admin panel gets threaded replies", async ({
  page,
  request,
}) => {
  test.setTimeout(420_000);
  const { channels } = state();
  const { mail } = channels;
  const tag = Date.now().toString(36);

  // Connect the inbox from the business's channel page, as agency staff would.
  await signIn(page, "admin@brightline.test");
  await page.goto(`${APP_URL}/businesses/${channels.businessId}/channels`);
  const card = page.getByTestId("channel-email");
  await expect(card.getByText("No inbox connected.")).toBeVisible();
  await card.getByText("Connect an IMAP/SMTP inbox").click();
  const form = card.getByTestId("imap-form");
  await form.getByLabel("Inbox address").fill(mail.address);
  await form.getByLabel("Sender name").fill("Jo at Northside");
  await form.getByLabel("IMAP server").fill("127.0.0.1");
  await form.getByLabel("IMAP port").fill(String(mail.imapPort));
  await form.getByLabel("SMTP server").fill("127.0.0.1");
  await form.getByLabel("SMTP port").fill(String(mail.smtpPort));
  await form.getByLabel("SMTP security").selectOption("starttls");
  await form.getByLabel("Login (usually the address)").fill(mail.address);
  await form.getByLabel("Password", { exact: true }).fill(mail.password);
  await form.getByRole("button", { name: "Check and connect" }).click();
  await expect(card.getByTestId("email-inbox")).toContainText(mail.address, { timeout: 30_000 });
  expect(await page.content()).not.toContain(mail.password);

  // A customer writes; the inbox is polled every minute.
  const customer = `dana.${tag}@example.net`;
  const firstId = `<first-${tag}@mail.example.net>`;
  const before = (await mailbox(request)).length;
  await request.post(`${FAKES_URL}/__e2e/mail/deliver`, {
    data: rawEmail({
      from: `"Dana Price" <${customer}>`,
      to: mail.address,
      subject: `Gutters pulling away ${tag}`,
      date: new Date().toUTCString(),
      messageId: firstId,
      text: "Hi, the gutters on the back of our house are pulling away from the roof. Could someone come out this week?\n\nDana",
    }),
  });
  const replyTo = async (messageId: string) => {
    let found: string | undefined;
    await expect
      .poll(
        async () => {
          found = (await mailbox(request))
            .slice(before)
            .map((message) => message.raw)
            .find((raw) => raw.includes(`In-Reply-To: ${messageId}`));
          return found !== undefined;
        },
        { timeout: 180_000, intervals: [2_000] },
      )
      .toBe(true);
    return parseEmail(found!);
  };
  const reply = await replyTo(firstId);
  expect(reply.subject).toBe(`Re: Gutters pulling away ${tag}`);
  expect(reply.to.map((item) => item.address)).toEqual([customer]);
  expect(reply.from?.address).toBe(mail.address);
  expect(reply.references).toEqual([firstId]);

  // The customer answers in the thread: the next reply continues it.
  const secondId = `<second-${tag}@mail.example.net>`;
  await request.post(`${FAKES_URL}/__e2e/mail/deliver`, {
    data: rawEmail({
      from: `"Dana Price" <${customer}>`,
      to: mail.address,
      subject: `Re: Gutters pulling away ${tag}`,
      date: new Date().toUTCString(),
      messageId: secondId,
      inReplyTo: reply.messageId!,
      references: `${firstId} ${reply.messageId!}`,
      text: "Yes, I own the house. The ZIP is 55418.",
    }),
  });
  const second = await replyTo(secondId);
  expect(second.references).toEqual([firstId, reply.messageId, secondId]);

  // The conversation is in the inbox, on the email channel.
  await page.goto(`${APP_URL}/inbox`);
  await page.getByRole("searchbox", { name: "Search conversations" }).fill(tag);
  await page.getByRole("button", { name: "Filter" }).click();
  await expect(page.getByTestId("inbox-row")).toHaveCount(1);
  await expect(page.getByTestId("inbox-row")).toContainText(/email/i);
});
