import { readFileSync } from "node:fs";

import { expect, type Locator, type Page, test } from "@playwright/test";

import {
  and,
  attachments,
  conversations,
  createDatabase,
  desc,
  eq,
  leadReports,
  leads,
  routingDecisions,
} from "@repo/db";

import { APP_URL, type E2eState, OTHER_SITE_URL, SITE_URL, STATE_FILE } from "./support/config";

/*
 * The website chat on a business's site, end to end: the snippet on a page of another origin,
 * the pre-chat form, a qualifying conversation with the bot (the offline model, through the
 * real pipeline and engine), a photo upload, a reload that keeps the conversation, and a site
 * that is not on the business's list. Runs at desktop and phone widths (the two projects).
 */

const state = (): E2eState => JSON.parse(readFileSync(STATE_FILE, "utf8")) as E2eState;

/** What a homeowner with a leaking roof answers to each question the bot may ask. */
function answerFor(question: string): string {
  const q = question.toLowerCase();
  if (q.includes("zip")) return "The ZIP is 80214.";
  if (q.includes("how soon")) return "As soon as possible, this week if you can.";
  if (q.includes("own the home")) return "Yes, I own the home.";
  if (q.includes("kind of property")) return "It's a single family house.";
  if (q.includes("budget")) return "Somewhere around $12,000 if it needs a new roof.";
  if (q.includes("address")) return "It's 1450 Garrison Street in Lakewood.";
  if (q.includes("a bit more")) return "Water drips into the upstairs bedroom when it rains.";
  return "Yes.";
}

async function openChat(page: Page, businessName: string): Promise<void> {
  await page.getByRole("button", { name: `Chat with ${businessName}` }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

function botMessages(page: Page): Locator {
  return page.locator('.msg[data-from="bot"]');
}

async function lastBotText(page: Page, count: number): Promise<string> {
  await expect(botMessages(page)).toHaveCount(count);
  return (await botMessages(page).last().textContent()) ?? "";
}

async function say(page: Page, text: string): Promise<void> {
  const box = page.getByRole("textbox", { name: "Message" });
  await box.fill(text);
  await box.press("Enter");
}

/** A real JPEG, drawn by the browser itself. */
async function jpegFromBrowser(page: Page): Promise<Buffer> {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 200;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#7c2d12";
    context.fillRect(0, 0, 320, 200);
    context.fillStyle = "#94a3b8";
    context.fillRect(120, 20, 60, 120);
    return canvas.toDataURL("image/jpeg", 0.8);
  });
  return Buffer.from(dataUrl.split(",")[1]!, "base64");
}

test("a visitor qualifies through the widget and sends a photo", async ({ page }, testInfo) => {
  const { businessName, businessId, agencyId, databaseUrl } = state();
  await page.goto(SITE_URL);
  // The host page's own styles do not reach inside the widget.
  const bubble = page.getByRole("button", { name: `Chat with ${businessName}` });
  await expect(bubble).toBeVisible();
  expect(await bubble.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(
    "rgb(29, 78, 216)",
  );
  await openChat(page, businessName);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(businessName, { exact: true })).toBeVisible();
  await expect(dialog.getByText("Roof questions? Ask Riley.")).toBeVisible();
  await expect(dialog.getByText(`Thanks for stopping by ${businessName}`)).toBeVisible();

  if (testInfo.project.name === "mobile") {
    // Full screen on a phone.
    const box = await dialog.boundingBox();
    expect(box?.width).toBe(390);
    expect(box?.height).toBe(844);
  }

  // The business asks for contact details first.
  await expect(page.getByRole("textbox", { name: "Message" })).toBeHidden();
  await dialog.getByLabel("Your name").fill("Pat Lee");
  await dialog.getByLabel("Phone number").fill("(303) 555-0142");
  await dialog.getByLabel("Email address").fill("pat@example.com");
  await dialog.getByRole("button", { name: "Start chat" }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("1-open.png") });

  await say(page, "Hi, my roof is leaking around the chimney after the storm last night.");
  await expect(page.locator('.msg[data-from="visitor"]')).toHaveCount(1);
  let question = await lastBotText(page, 1);
  expect(question).toContain(businessName);
  // The bot knows the visitor's name and number from the form: it does not ask again.
  expect(question.toLowerCase()).not.toMatch(/your name|phone number|email address/);

  // A photo of the leak.
  const photo = await jpegFromBrowser(page);
  await page.locator('input[type="file"]').setInputFiles({
    name: "chimney-leak.jpg",
    mimeType: "image/jpeg",
    buffer: photo,
  });
  await expect(page.locator('.msg[data-from="visitor"] img')).toHaveCount(1);
  // Once stored, the photo is shown from the app's storage, not from the browser's memory.
  await expect(page.locator('.msg[data-from="visitor"] img')).toHaveAttribute(
    "src",
    new RegExp(`^${APP_URL}/api/storage/local/`),
  );
  question = await lastBotText(page, 2);

  // Answer the bot's questions until it has what the team needs.
  let bots = 2;
  for (let turn = 0; turn < 8 && !/what the team needs|reach out/i.test(question); turn += 1) {
    await say(page, answerFor(question));
    bots += 1;
    question = await lastBotText(page, bots);
  }
  expect(question).toMatch(/that's what the team needs/i);
  await expect(page.locator(".typing")).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("2-qualified.png") });

  // The lead was scored, reported and routed.
  const db = createDatabase({ url: databaseUrl, max: 1, applicationName: "e2e-check" });
  try {
    const result = await db
      .forBusiness(businessId as never, { agencyId: agencyId as never })
      .run(async (ctx) => {
        const [conversation] = await ctx.tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(
              eq(conversations.businessId, businessId as never),
              eq(conversations.channel, "widget"),
            ),
          )
          .orderBy(desc(conversations.createdAt))
          .limit(1);
        const [lead] = await ctx.tx
          .select()
          .from(leads)
          .where(eq(leads.conversationId, conversation!.id));
        const reports = await ctx.tx
          .select()
          .from(leadReports)
          .where(eq(leadReports.leadId, lead!.id));
        const routes = await ctx.tx
          .select()
          .from(routingDecisions)
          .where(eq(routingDecisions.leadId, lead!.id));
        return { lead, reports: reports.length, routes: routes.map((row) => row.outcome) };
      });
    expect(result.lead?.score).toBeGreaterThan(0);
    expect(result.reports).toBeGreaterThan(0);
    expect(result.routes.length).toBeGreaterThan(0);
  } finally {
    await db.close();
  }

  // The conversation survives a reload: same session, same history, chat still open.
  const before = await page.locator(".msg").count();
  await page.reload();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator(".msg")).toHaveCount(before);
  await expect(page.locator('.msg[data-from="visitor"] img')).toHaveCount(1);

  // Closing and reopening keeps it too.
  await page.getByRole("button", { name: "Close chat" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await openChat(page, businessName);
  await expect(page.locator(".msg")).toHaveCount(before);
});

/** A PNG of random pixels (it does not compress), larger than a serverless request may be. */
async function noisyPngFromBrowser(page: Page): Promise<Buffer> {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 2600;
    canvas.height = 1600;
    const context = canvas.getContext("2d")!;
    const image = context.createImageData(canvas.width, canvas.height);
    for (let offset = 0; offset < image.data.length; offset += 65_536) {
      crypto.getRandomValues(image.data.subarray(offset, offset + 65_536));
    }
    for (let alpha = 3; alpha < image.data.length; alpha += 4) image.data[alpha] = 255;
    context.putImageData(image, 0, 0);
    return canvas.toDataURL("image/png");
  });
  return Buffer.from(dataUrl.split(",")[1]!, "base64");
}

test("a large photo is made smaller before it is sent", async ({ page }) => {
  const { businessName, businessId, agencyId, databaseUrl } = state();
  await page.goto(SITE_URL);
  await openChat(page, businessName);
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Your name").fill("Sam Ortiz");
  await dialog.getByLabel("Phone number").fill("(303) 555-0177");
  await dialog.getByLabel("Email address").fill("sam@example.com");
  await dialog.getByRole("button", { name: "Start chat" }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();

  const png = await noisyPngFromBrowser(page);
  // Over the 4.5 MB a Vercel function accepts (and over the 10 MB the business allows).
  expect(png.length).toBeGreaterThan(10 * 1024 * 1024);
  await page.locator('input[type="file"]').setInputFiles({
    name: "whole-roof.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(page.locator('.msg[data-from="visitor"] img')).toHaveAttribute(
    "src",
    new RegExp(`^${APP_URL}/api/storage/local/`),
  );
  await expect(page.locator(".error")).toBeHidden();

  const db = createDatabase({ url: databaseUrl, max: 1, applicationName: "e2e-check" });
  try {
    const [stored] = await db
      .forBusiness(businessId as never, { agencyId: agencyId as never })
      .run((ctx) =>
        ctx.tx
          .select({ mimeType: attachments.mimeType, sizeBytes: attachments.sizeBytes })
          .from(attachments)
          .where(eq(attachments.businessId, businessId as never))
          .orderBy(desc(attachments.createdAt))
          .limit(1),
      );
    expect(stored?.mimeType).toBe("image/jpeg");
    expect(stored?.sizeBytes).toBeLessThan(4 * 1024 * 1024);
  } finally {
    await db.close();
  }
});

test("a site that is not on the business's list gets no chat", async ({ page, request }) => {
  const { widgetKey } = state();
  const warnings: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "warning") warnings.push(message.text());
  });
  await page.goto(OTHER_SITE_URL);
  await expect.poll(() => warnings.join("\n")).toContain("Chat widget: not shown");
  await expect(page.getByRole("button", { name: /^Chat with/ })).toHaveCount(0);

  // The API refuses the origin, without the CORS headers a browser would need to read it.
  for (const path of [`/api/widget/v1/config?key=${widgetKey}`]) {
    const response = await request.get(`${APP_URL}${path}`, {
      headers: { origin: OTHER_SITE_URL },
    });
    expect(response.status()).toBe(403);
    expect(response.headers()["access-control-allow-origin"]).toBeUndefined();
  }
  const session = await request.post(`${APP_URL}/api/widget/v1/session`, {
    headers: { origin: OTHER_SITE_URL, "content-type": "application/json" },
    data: { key: widgetKey, token: null },
  });
  expect(session.status()).toBe(403);
  // A page on the refused origin cannot read the API either.
  const read = await page.evaluate(async (url) => {
    try {
      await fetch(url);
      return "read";
    } catch {
      return "blocked";
    }
  }, `${APP_URL}/api/widget/v1/config?key=${widgetKey}`);
  expect(read).toBe("blocked");
  // The allowed site gets an answer.
  const allowed = await request.get(`${APP_URL}/api/widget/v1/config?key=${widgetKey}`, {
    headers: { origin: SITE_URL },
  });
  expect(allowed.status()).toBe(200);
  expect(allowed.headers()["access-control-allow-origin"]).toBe(SITE_URL);
});
