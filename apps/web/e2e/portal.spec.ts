import { expect, type Page, test } from "@playwright/test";

import { DEMO } from "@repo/db/seed";

import { APP_URL } from "./support/config";

/*
 * The client portal and analytics (C16) in a real browser at desktop and phone widths. The
 * owner of Summit Roofing sees their own business's conversations, leads, reports and
 * analytics, and nothing of Evergreen's, even by address; their staff member sees what the
 * default client-portal settings allow (no reports, no export, no analytics); nobody without
 * the permission can take a conversation over. Analytics totals for Evergreen (no other test
 * writes there) match the demo data.
 */

const PASSWORD = "brightline-demo";
// Seeded conversations (packages/db/src/seed/demo.ts).
const DANA = "a0000000-0000-4000-8000-000000001001";
const HELEN = "a0000000-0000-4000-8000-000000001101";

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

test("a client owner sees only their own business's conversations, leads and analytics", async ({
  page,
}) => {
  await signIn(page, "owner@summitroofing.test");
  const nav = page.getByRole("navigation", { name: "Main", includeHidden: true }).first();
  await expect(nav.getByRole("link", { name: "Audit log", includeHidden: true })).toHaveCount(0);

  await page.goto(`${APP_URL}/inbox?status=all`);
  const rows = page.getByTestId("inbox-row");
  await expect(rows.filter({ hasText: "Dana Whitfield" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "Helen Kowalski" })).toHaveCount(0);
  await expect(rows.filter({ hasText: "Jordan Blake" })).toHaveCount(0);
  await noSideScroll(page);

  // Their own conversation: messages, lead and report; no takeover (the default is "nobody"),
  // no internal notes, no emergencies.
  await page.goto(`${APP_URL}/inbox/${DANA}`);
  await expect(page.getByRole("heading", { name: "Dana Whitfield" })).toBeVisible();
  await expect(page.getByTestId("lead-panel")).toContainText("Homeowner in Lakewood");
  await expect(page.getByRole("button", { name: "Take over" })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Internal notes" })).toHaveCount(0);
  await expect(page.getByText("Internal notes")).toHaveCount(0);
  await noSideScroll(page);

  // Evergreen's conversation and pages, by address: not found.
  expect((await page.goto(`${APP_URL}/inbox/${HELEN}`))?.status()).toBe(404);
  expect((await page.goto(`${APP_URL}/inbox/not-a-conversation`))?.status()).toBe(404);
  expect((await page.goto(`${APP_URL}/audit`))?.status()).not.toBe(500);
  await expect(page.getByTestId("audit-row")).toHaveCount(0);

  // Leads: their four, with the CSV; a business id of Evergreen's in the address is ignored.
  await page.goto(`${APP_URL}/leads?business=${DEMO.businesses.hvac}`);
  await expect(page.getByTestId("lead-row").filter({ hasText: "Helen Kowalski" })).toHaveCount(0);
  await expect(page.getByTestId("lead-row").filter({ hasText: "Dana Whitfield" })).toHaveCount(1);
  const csv = await page.request.get(
    `${APP_URL}/api/leads/export?business=${DEMO.businesses.hvac}`,
  );
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  const text = await csv.text();
  expect(text).toContain("Dana Whitfield");
  expect(text).not.toContain("Helen Kowalski");
  expect(text).not.toContain("Evergreen");
  await noSideScroll(page);

  // Analytics: Summit's own numbers.
  await page.goto(`${APP_URL}/analytics`);
  await expect(page.getByTestId("by-business")).toHaveCount(0);
  await expect(page.getByTestId("by-channel")).toContainText("Website chat");
  await noSideScroll(page);
});

test("a client staff member gets what the default settings allow", async ({ page }) => {
  await signIn(page, "staff@summitroofing.test");
  const nav = page.getByRole("navigation", { name: "Main", includeHidden: true }).first();
  await expect(nav.getByRole("link", { name: "Inbox", includeHidden: true })).toHaveCount(1);
  await expect(nav.getByRole("link", { name: "Analytics", includeHidden: true })).toHaveCount(0);
  await page.goto(`${APP_URL}/inbox/${DANA}`);
  await expect(page.getByRole("heading", { name: "Dana Whitfield" })).toBeVisible();
  // Reports are for the owner by default.
  await expect(page.getByTestId("lead-panel")).not.toContainText("Homeowner in Lakewood");
  await page.goto(`${APP_URL}/leads`);
  await expect(page.getByTestId("export-csv")).toHaveCount(0);
  expect((await page.request.get(`${APP_URL}/api/leads/export`)).status()).toBe(404);
  await page.goto(`${APP_URL}/analytics`);
  await expect(page.getByText("There are no analytics for you to see.")).toBeVisible();
});

test("analytics totals match the seeded data", async ({ page }) => {
  await signIn(page, "admin@brightline.test");
  await page.goto(`${APP_URL}/analytics?days=30&business=${DEMO.businesses.hvac}`);
  // Evergreen's three seeded conversations: Helen and Jordan qualified (test chat, replies
  // after 2 minutes), Luis on the website chat (reply after 60 s) replied once and stopped.
  await expect(page.getByTestId("kpi-conversations").locator("[data-value]")).toHaveText("3");
  await expect(page.getByTestId("kpi-first-response").locator("[data-value]")).toHaveText("2 min");
  await expect(page.getByTestId("kpi-first-response")).toContainText("Mean 2 min");
  await expect(page.getByTestId("kpi-qualification").locator("[data-value]")).toHaveText("67%");
  await expect(page.getByTestId("kpi-booked").locator("[data-value]")).toHaveText("0");
  await expect(page.getByTestId("kpi-drop-off").locator("[data-value]")).toHaveText("Qualified");
  const channels = page.getByTestId("by-channel");
  await expect(channels.locator('[data-row="test"]')).toContainText("2");
  await expect(channels.locator('[data-row="widget"]')).toContainText("1");
  await expect(page.getByTestId("funnel").locator('[data-step="engaged"]')).toContainText("3");
  await noSideScroll(page);
});
