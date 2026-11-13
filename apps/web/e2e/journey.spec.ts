import { readFileSync } from "node:fs";

import { expect, type Page, test } from "@playwright/test";

import { APP_URL, type E2eState, STATE_FILE } from "./support/config";

/*
 * The whole journey on the test channel (C18), at desktop and phone widths: a customer
 * qualifies through the dev chat (the same pipeline as every channel), and the team finds the
 * lead with its score and report in the inbox and in the lead list, and exports it. The bot is
 * the offline rule-based stand-in: this proves the plumbing, not the quality of the replies.
 */

const state = (): E2eState => JSON.parse(readFileSync(STATE_FILE, "utf8")) as E2eState;
const PASSWORD = "brightline-demo";
const DONE = /what the team needs|reach out|be in touch/i;

function answerFor(question: string): string {
  const q = question.toLowerCase();
  if (q.includes("zip")) return "The ZIP is 80214.";
  if (q.includes("how soon")) return "As soon as possible, this week if you can.";
  if (q.includes("own the home")) return "Yes, I own the home.";
  if (q.includes("kind of property")) return "It's a single family house.";
  if (q.includes("budget")) return "Somewhere around $9,000.";
  if (q.includes("address")) return "It's 1450 Garrison Street in Lakewood.";
  if (q.includes("name")) return "I'm Robin Hale.";
  if (q.includes("phone")) return "303-555-0164.";
  if (q.includes("email")) return "robin.hale@example.com";
  if (q.includes("a bit more")) return "Several shingles blew off in the wind last night.";
  return "Yes.";
}

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto(`${APP_URL}/sign-in`);
  await page.getByLabel("Email").first().fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/businesses"));
}

test("a customer qualifies on the test channel and the team finds the lead, its score and report", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const { businessId } = state();
  const tag = `${testInfo.project.name}-${Date.now().toString(36)}`;
  await signIn(page, "admin@brightline.test");
  await page.goto(`${APP_URL}/dev/chat?business=${businessId}`);
  await page.waitForURL(/visitor=/);

  const bot = page.locator('div:has(> span:text-is("Bot")) > p');
  const say = async (text: string) => {
    const count = await bot.count();
    await page.getByRole("textbox", { name: "Message" }).fill(text);
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => bot.count(), { timeout: 60_000 }).toBeGreaterThan(count);
    return (await bot.last().textContent()) ?? "";
  };

  let question = await say(`Hi, a storm tore shingles off my roof ${tag}`);
  for (let turn = 0; turn < 10 && !DONE.test(question); turn += 1) {
    question = await say(answerFor(question));
  }
  expect(question).toMatch(DONE);

  // The inbox: the conversation, the lead's score and its report.
  await page.goto(`${APP_URL}/inbox`);
  await page.getByRole("searchbox", { name: "Search conversations" }).fill(tag);
  await page.getByRole("button", { name: "Filter" }).click();
  await expect(page.getByTestId("inbox-row")).toHaveCount(1);
  await page.getByTestId("inbox-row").getByRole("link").click();
  await page.waitForURL(/\/inbox\/[0-9a-f-]{36}$/);
  const conversationId = /\/inbox\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
  const panel = page.getByTestId("lead-panel");
  await expect(panel.getByRole("heading", { name: "Report" })).toBeVisible();
  await expect(panel).not.toContainText("No report yet.");

  // The lead list links to it, and the CSV export answers.
  await page.goto(`${APP_URL}/leads`);
  await expect(
    page.locator(`[data-testid="lead-row"] a[href="/inbox/${conversationId}"]`),
  ).toHaveCount(1);
  const csv = await page.request.get(`${APP_URL}/api/leads/export?business=${businessId}`);
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  await page.screenshot({ path: testInfo.outputPath("leads.png") });
});
