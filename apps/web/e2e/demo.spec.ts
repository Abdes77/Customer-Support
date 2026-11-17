import { readFileSync } from "node:fs";

import { expect, type Locator, type Page, test } from "@playwright/test";

import { conversations, createDatabase, eq, leads } from "@repo/db";

import { APP_URL, type E2eState, STATE_FILE } from "./support/config";

/*
 * The public demo site, end to end, as a visitor without a login: the front door leads to
 * `/demo`, a sample business's page embeds its real chat (on the app's own origin), a
 * conversation runs through the real pipeline and engine (the offline model), and the panel
 * next to the chat shows the lead of that conversation. Runs at desktop and phone widths.
 */

const state = (): E2eState => JSON.parse(readFileSync(STATE_FILE, "utf8")) as E2eState;

/** What a homeowner with a leaking roof answers to each question the bot may ask. */
function answerFor(question: string): string {
  const q = question.toLowerCase();
  if (q.includes("zip") || q.includes("city") || q.includes("town")) return "Lakewood, 80214.";
  if (q.includes("how soon")) return "As soon as possible, this week if you can.";
  if (q.includes("own the home")) return "Yes, I own the home.";
  if (q.includes("kind of property")) return "It's a single family house.";
  return "Yes.";
}

function botMessages(page: Page): Locator {
  return page.locator('.msg[data-from="bot"]');
}

test("a visitor chats on the demo site and watches the lead being scored", async ({ page }) => {
  const { demo, databaseUrl } = state();

  // Not signed in: the front door is the demo, and it lists the sample businesses only.
  await page.goto(`${APP_URL}/`);
  await expect(page).toHaveURL(`${APP_URL}/demo`);
  await expect(page.getByTestId("demo-card")).toHaveCount(2);
  await expect(page.getByText("Summit Roofing Co.")).toHaveCount(0);
  await page.getByTestId("demo-card").filter({ hasText: demo.name }).click();
  await expect(page).toHaveURL(`${APP_URL}/demo/${demo.slug}`);

  const panel = page.getByTestId("demo-lead-panel");
  await expect(panel).toContainText("What the business sees");
  await expect(page.getByTestId("demo-score")).toHaveCount(0);

  // A sample question opens the chat and sends the line as the visitor.
  await page.getByRole("button", { name: /Water is dripping through my bedroom ceiling/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator('.msg[data-from="visitor"]')).toHaveCount(1);
  await expect(botMessages(page)).toHaveCount(1);

  for (let turn = 1; turn <= 3; turn += 1) {
    const question = (await botMessages(page).last().textContent()) ?? "";
    const box = page.getByRole("textbox", { name: "Message" });
    await box.fill(answerFor(question));
    await box.press("Enter");
    await expect(botMessages(page)).toHaveCount(turn + 1);
  }

  // The panel shows the lead of this conversation: score, answers with the visitor's words.
  await page.getByRole("button", { name: "Close chat" }).click();
  await expect(page.getByTestId("demo-score")).toBeVisible();
  expect(Number(await page.getByTestId("demo-score").textContent())).toBeGreaterThan(0);
  const fields = page.getByTestId("demo-fields");
  await expect(fields).toContainText("Service type");
  await expect(fields).toContainText("Water is dripping through my bedroom ceiling");
  await expect(panel).toContainText("Report for the business");

  // It is an ordinary conversation and lead of that business.
  const db = createDatabase({ url: databaseUrl, max: 1 });
  try {
    const rows = await db.forBusiness(demo.businessId as never).run((ctx) =>
      ctx.tx
        .select({ score: leads.score, channel: conversations.channel })
        .from(leads)
        .innerJoin(conversations, eq(conversations.id, leads.conversationId))
        .where(eq(leads.businessId, demo.businessId as never)),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.channel === "widget")).toBe(true);
  } finally {
    await db.close();
  }

  // "Start over" forgets the visitor: a fresh chat and an empty panel.
  await page.getByRole("button", { name: "Start over as a new customer" }).click();
  await expect(page.getByTestId("demo-business")).toBeVisible();
  await expect(page.getByTestId("demo-score")).toHaveCount(0);
});

test("only a business with its demo page on has one, and its lead is served to nobody else", async ({
  page,
  request,
}) => {
  const { demo } = state();
  // Summit Roofing has a website chat but no public demo page.
  const response = await page.goto(`${APP_URL}/demo/summit-roofing`);
  expect(response?.status()).toBe(404);
  expect((await page.goto(`${APP_URL}/demo/${demo.slug}`))?.status()).toBe(200);

  const lead = `${APP_URL}/api/widget/v1/demo/lead`;
  // No session, a forged one, and a request from another site.
  expect((await request.get(lead, { headers: { origin: APP_URL } })).status()).toBe(401);
  expect(
    (
      await request.get(lead, { headers: { origin: APP_URL, authorization: "Bearer forged" } })
    ).status(),
  ).toBe(401);
  expect((await request.get(lead)).status()).toBe(403);
});
