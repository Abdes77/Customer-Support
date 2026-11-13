import { readFileSync } from "node:fs";

import { expect, type Page, test } from "@playwright/test";

import { DEMO } from "@repo/db/seed";

import { APP_URL, type E2eState, STATE_FILE } from "./support/config";

/*
 * The admin panel (C15) in a real browser, at desktop and phone widths (the two projects):
 * an agency admin onboards a new business through the whole wizard; a setting is overridden
 * and reset at business scope; a client user sees only their own business. The app runs on
 * a fresh database with the demo data, in-process jobs and the offline model (no API key),
 * so the playbook of a new segment is the built-in starter and the page must say so.
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

/** Nothing on the page is wider than the screen (a phone must never scroll sideways). */
async function noSideScroll(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    screen: window.innerWidth,
  }));
  expect(widths.page).toBeLessThanOrEqual(widths.screen);
}

const CSV = [
  "Category,Title,Text",
  "services,Ant control,Indoor and outdoor ant treatments with a 90-day guarantee.",
  'service_area,Where we work,"Austin and Round Rock, Texas."',
  "licenses,License,Licensed by the Texas Department of Agriculture.",
].join("\n");

test("an agency admin onboards a new business through the wizard", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const suffix = testInfo.project.name === "desktop" ? "D" : "M";
  const name = `Lone Star Pest Control ${suffix}`;
  await signIn(page, "admin@brightline.test");

  // Step 1: profile.
  await page.getByRole("link", { name: "Onboard a business" }).click();
  await expect(page.getByRole("heading", { name: "Onboard a business" })).toBeVisible();
  await page.getByLabel("Business name").fill(name);
  await page.getByLabel("Website").fill("https://lonestarpest.example.com");
  await page.getByLabel("Phone").fill("+1 512 555 0100");
  await page.getByLabel("Email").fill("office@lonestarpest.example.com");
  await page.getByLabel("City").fill("Austin");
  await page.getByLabel("State").fill("TX");
  await page.getByLabel("ZIP code").fill("78701");
  await page.getByLabel("Time zone").selectOption("America/Chicago");
  await noSideScroll(page);
  await page.getByRole("button", { name: "Create and continue" }).click();

  // Step 2: segment. A segment the agency never served: its playbook is generated.
  await page.waitForURL(/\/onboarding\/segment$/);
  const businessId = /\/businesses\/([0-9a-f-]{36})\//.exec(page.url())![1]!;
  await page.getByText("A segment the agency has not served yet").click();
  await page.getByLabel("Name of the new segment").fill(`Pest control ${suffix}`);
  await noSideScroll(page);
  await page.getByRole("button", { name: "Save and continue" }).click();

  // Step 3: the agency's lead-generation data, as a CSV file.
  await page.waitForURL(/\/onboarding\/import\?assigned=generating$/);
  await expect(page.getByText("The segment's playbook is being written now.")).toBeVisible();
  await page.getByLabel("CSV file from your lead-generation data").setInputFiles({
    name: "lonestar.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(CSV),
  });
  const preview = page.getByTestId("csv-preview");
  await expect(preview).toContainText("3 rows in lonestar.csv");
  await expect(page.getByLabel("Column Category")).toHaveValue("fact_category");
  await noSideScroll(page);
  await page.getByRole("button", { name: "Import 3 records" }).click();
  await expect(page.getByTestId("import-outcome")).toContainText("3 facts added");
  await expect(page.getByTestId("fact-count")).toContainText("3 facts so far.");
  await page.getByRole("link", { name: "Continue" }).click();

  // Step 4: the playbook. Without a key it is the built-in starter, and the page says so.
  await page.waitForURL(/\/onboarding\/playbook$/);
  await expect(page.getByTestId("playbook-origin")).toContainText(
    "Built-in starter, not generated",
    {
      timeout: 60_000,
    },
  );
  await expect(page.getByText("NOT researched or written by the Claude API")).toBeVisible();
  await expect(page.getByText("Common jobs")).toBeVisible();
  await noSideScroll(page);
  await page.getByRole("link", { name: "Continue" }).click();

  // Step 5: alert contacts. Both chains start empty: the business is plainly not ready.
  await page.waitForURL(/\/onboarding\/alerts$/);
  const readiness = page.getByTestId("readiness");
  await expect(readiness).toContainText(
    "Not ready: an emergency at this business would reach nobody",
  );
  const chain = page.locator('[data-setting-key="emergency.escalation_chain"]');
  await chain.getByRole("button", { name: "Add contact" }).click();
  await chain.getByLabel("Escalation chain: Name").fill("Dana (on call)");
  await chain.getByLabel("Escalation chain: Mobile number").fill("+1 512 555 0142");
  await chain.getByText("Text message", { exact: true }).click();
  await chain.getByRole("button", { name: "Add", exact: true }).click();
  await expect(chain.getByTestId("setting-entries")).toContainText("Dana (on call)");
  await expect(chain.getByTestId("setting-entries")).toContainText("0142");
  // The contact list is private: the number never reaches the browser in full.
  expect(await page.content()).not.toContain("5125550142");
  // This deployment has no Twilio, so the contact cannot be texted: still not ready.
  await expect(readiness).toContainText("cannot send text messages");
  await expect(readiness).toContainText("Not ready");
  await noSideScroll(page);
  await page.getByRole("link", { name: "Continue" }).click();

  // Step 6: a test chat with the bot on the test channel.
  await page.waitForURL(/\/onboarding\/test\?visitor=/);
  await expect(page.getByText("offline stand-in")).toBeVisible();
  await page.getByRole("textbox", { name: "Message" }).fill("Hi, I have ants all over my kitchen.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Hi, I have ants all over my kitchen.")).toBeVisible();
  await expect(page.getByText("Bot", { exact: true }).first()).toBeVisible({ timeout: 90_000 });
  await page.getByRole("link", { name: "Continue" }).click();

  // Step 7: finish. Activation needs an explicit acknowledgement while nobody is reachable.
  await page.waitForURL(/\/onboarding\/finish$/);
  await expect(page.getByTestId("readiness")).toContainText("Not ready");
  const activate = page.getByRole("button", { name: "Activate the business" });
  await expect(activate).toBeDisabled();
  await noSideScroll(page);
  await page.getByText("I understand that an emergency at this business").click();
  await activate.click();
  await page.waitForURL(new RegExp(`/businesses/${businessId}\\?activated=1$`));
  await expect(page.getByText("The business is live")).toBeVisible();
  await expect(page.getByText("Active", { exact: true }).first()).toBeVisible();

  // The list shows the new business as active, and still as not ready for emergencies.
  await page.goto(`${APP_URL}/businesses?q=${encodeURIComponent(name)}`);
  const row = page.getByRole("link", { name: new RegExp(name) });
  await expect(row).toContainText("Active");
  await expect(row).toContainText("Emergencies reach nobody");
});

test("a setting is overridden and reset at business scope", async ({ page }, testInfo) => {
  const { businessId } = state();
  await signIn(page, "member@brightline.test");
  await page.goto(`${APP_URL}/businesses/${businessId}/settings?category=persona`);
  const row = page.locator('[data-setting-key="persona.role_title"]');
  await expect(row.getByText("Default", { exact: true })).toBeVisible();
  const before = (await row.getByTestId("setting-value").textContent()) ?? "";

  const role = `${testInfo.project.name} office coordinator`;
  await row.getByRole("button", { name: "Override" }).click();
  await row.getByRole("textbox").fill(role);
  await row.getByRole("button", { name: "Save" }).click();
  await expect(row.getByText("Saved.")).toBeVisible();
  await noSideScroll(page);
  await expect(row.getByTestId("setting-value")).toHaveText(role);
  await expect(row.getByText("Set here", { exact: true })).toBeVisible();
  await expect(row).toContainText(`Without this override: ${before}`);

  // A value the field refuses is caught before it is sent, and nothing changes.
  await row.getByRole("button", { name: "Change" }).click();
  await row.getByRole("textbox").fill("");
  await row.getByRole("button", { name: "Save" }).click();
  await expect(row.getByText("Fix the marked values first.")).toBeVisible();
  await row.getByRole("button", { name: "Cancel" }).click();

  await row.getByRole("button", { name: "Reset to inherited" }).click();
  await expect(row.getByText("Default", { exact: true })).toBeVisible();
  await expect(row.getByTestId("setting-value")).toHaveText(before);

  // After a reload the stored state is the same.
  await page.reload();
  await expect(
    page.locator('[data-setting-key="persona.role_title"]').getByTestId("setting-value"),
  ).toHaveText(before);
});

test("a client user sees only their own business", async ({ page }) => {
  const { businessId } = state();
  await signIn(page, "owner@summitroofing.test");
  await page.goto(`${APP_URL}/businesses`);
  await expect(page.getByRole("heading", { name: "Your businesses" })).toBeVisible();
  const list = page.getByRole("list", { name: "Businesses" });
  await expect(list.getByRole("link")).toHaveCount(1);
  await expect(list).toContainText("Summit Roofing Co.");
  await expect(page.getByRole("link", { name: "Playbooks" })).toHaveCount(0);

  // Another business of the same agency, by its address: not found.
  const other = await page.goto(`${APP_URL}/businesses/${DEMO.businesses.hvac}`);
  expect(other?.status()).toBe(404);
  const otherSettings = await page.goto(`${APP_URL}/businesses/${DEMO.businesses.hvac}/settings`);
  expect(otherSettings?.status()).toBe(404);
  // Agency pages send a client user back to their business list.
  await page.goto(`${APP_URL}/playbooks`);
  await page.waitForURL(/\/businesses$/);

  // Their own settings: only what clients may change, nothing of the agency's own.
  await page.goto(`${APP_URL}/businesses/${businessId}/settings?category=persona`);
  await expect(page.getByText("The settings your agency lets you change")).toBeVisible();
  await expect(page.locator('[data-setting-key="persona.speaks_as"]')).toHaveCount(0);
  await expect(page.locator('[data-setting-key="persona.bot_name"]')).toHaveCount(1);
  // The onboarding wizard and the playbook editor are for agency staff.
  const wizard = await page.goto(`${APP_URL}/businesses/${businessId}/onboarding/profile`);
  expect(wizard?.status()).toBe(404);
});
