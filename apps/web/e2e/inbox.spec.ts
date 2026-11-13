import { readFileSync } from "node:fs";

import { expect, type Page, test } from "@playwright/test";

import { APP_URL, type E2eState, STATE_FILE } from "./support/config";

/*
 * The inbox (C16) in a real browser at desktop and phone widths: a customer writes on the test
 * channel, the bot answers, an agency member finds the conversation in the inbox, takes it
 * over, replies by hand (the customer's chat shows the reply once), leaves an internal note,
 * and releases it back to the bot, which answers the customer's next message again.
 */

const state = (): E2eState => JSON.parse(readFileSync(STATE_FILE, "utf8")) as E2eState;
const PASSWORD = "brightline-demo";

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto(`${APP_URL}/sign-in`);
  await page.getByLabel("Email").first().fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/businesses"));
}

async function noSideScroll(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    screen: window.innerWidth,
  }));
  expect(widths.page).toBeLessThanOrEqual(widths.screen);
}

test("an agency member takes a conversation over, replies on the test channel and releases it", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  const { businessId } = state();
  const tag = `${testInfo.project.name}-${Date.now().toString(36)}`;

  // The customer, on the test channel (the dev chat writes as a customer).
  const customer = await browser.newPage();
  await signIn(customer, "member@brightline.test");
  await customer.goto(`${APP_URL}/dev/chat?business=${businessId}`);
  await customer.waitForURL(/visitor=/);
  const first = `My gutter is hanging off ${tag}`;
  await customer.getByRole("textbox", { name: "Message" }).fill(first);
  await customer.getByRole("button", { name: "Send" }).click();
  await expect(customer.getByText(first)).toBeVisible();
  await expect(customer.getByText("Bot", { exact: true }).first()).toBeVisible({ timeout: 90_000 });

  // The agency member, in the inbox (at the project's width).
  await signIn(page, "member@brightline.test");
  await page.goto(`${APP_URL}/inbox`);
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search conversations" }).fill(tag);
  await page.getByRole("button", { name: "Filter" }).click();
  const row = page.getByTestId("inbox-row");
  await expect(row).toHaveCount(1);
  // Found by the customer's words; the row shows the newest message (the bot's answer).
  await expect(row).toContainText("Bot:");
  await noSideScroll(page);
  await row.getByRole("link").click();
  await page.waitForURL(/\/inbox\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("takeover-state")).toContainText("The bot is answering");
  await expect(page.getByTestId("lead-panel")).toBeVisible();
  await noSideScroll(page);

  // Take over: the bot stays silent, the reply box appears.
  await page.getByRole("button", { name: "Take over" }).click();
  await expect(page.getByTestId("takeover-state")).toContainText("You hold this conversation");
  const reply = `Hi, this is Morgan from Summit. I can come by tomorrow ${tag}`;
  await page.getByRole("textbox", { name: "Reply to the customer" }).fill(reply);
  await page.getByRole("button", { name: "Send reply" }).click();
  await expect(page.getByText("Sent through Test chat.")).toBeVisible();
  const mine = page.locator('[data-testid="message"][data-author="human_agent"]', {
    hasText: reply,
  });
  await expect(mine).toHaveCount(1);
  await expect(mine).toContainText("Morgan Member");

  // The customer gets it once, from a person.
  await expect(customer.getByText(reply)).toHaveCount(1, { timeout: 30_000 });
  await expect(customer.getByText("Person at the business").first()).toBeVisible();

  // While the member holds it, the customer's next message gets no bot reply.
  const during = `Great, what time? ${tag}`;
  const botBefore = await customer.getByText("Bot", { exact: true }).count();
  await customer.getByRole("textbox", { name: "Message" }).fill(during);
  await customer.getByRole("button", { name: "Send" }).click();
  await expect(customer.getByText(during)).toBeVisible();
  await expect(page.getByText(during)).toBeVisible({ timeout: 30_000 });
  await customer.waitForTimeout(4_000);
  expect(await customer.getByText("Bot", { exact: true }).count()).toBe(botBefore);

  // An internal note, shown to staff only.
  const note = `<b>Called back</b> ${tag}`;
  await page.getByRole("textbox", { name: "New internal note" }).fill(note);
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByRole("list", { name: "Internal notes" })).toContainText(note);
  await expect(customer.getByText(note)).toHaveCount(0);

  // Release: the bot has the conversation again and answers the next message.
  await page.getByRole("button", { name: "Release to the bot" }).click();
  await expect(page.getByTestId("takeover-state")).toContainText("The bot is answering");
  await expect(page.getByRole("textbox", { name: "Reply to the customer" })).toHaveCount(0);
  const after = `Thanks! ${tag}`;
  await customer.getByRole("textbox", { name: "Message" }).fill(after);
  await customer.getByRole("button", { name: "Send" }).click();
  await expect
    .poll(async () => customer.getByText("Bot", { exact: true }).count(), { timeout: 90_000 })
    .toBeGreaterThan(botBefore);
  await noSideScroll(page);
  await customer.close();
});
