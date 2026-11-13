import { expect, type Page, test } from "@playwright/test";

import { DEMO } from "@repo/db/seed";

import { APP_URL } from "./support/config";

/*
 * People management (C18) in a real browser at desktop and phone widths. An agency admin gives
 * a new person a client-owner login for Summit Roofing; that person signs in through the link
 * (local sign-in shows it instead of emailing it), sees Summit Roofing and nothing of Evergreen,
 * even by address; the admin removes the login and the person's very next request is turned
 * away. The agency's own team page: admins manage it, members only read it.
 */

const PASSWORD = "brightline-demo";
const SUMMIT = DEMO.businesses.roofing;
const EVERGREEN = DEMO.businesses.hvac;

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

test("an agency admin adds a client owner, who sees only their business until removed", async ({
  page,
  browser,
}, info) => {
  const email = `new-owner-${info.project.name}@summitroofing.test`;
  await signIn(page, "admin@brightline.test");
  await page.goto(`${APP_URL}/businesses/${SUMMIT}/people`);
  const rows = page.getByTestId("person-row");
  await expect(rows.filter({ hasText: "owner@summitroofing.test" }).first()).toBeVisible();
  await noSideScroll(page);

  const form = page.getByRole("form", { name: "Add a person" });
  await form.getByLabel("Email").fill(`  ${email.toUpperCase()} `);
  await form.getByLabel("Role").selectOption("client_owner");
  await form.getByRole("button", { name: "Add and invite" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: `${email} now has access` }),
  ).toBeVisible();
  const link = await page.getByTestId("local-invite-link").getAttribute("href");
  expect(link).toMatch(/^\/auth\/confirm\?token_hash=/);
  const row = rows.filter({ hasText: email });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Business owner");
  await noSideScroll(page);

  // The new owner opens the link in their own browser.
  const context = await browser.newContext({
    viewport: page.viewportSize(),
    isMobile: info.project.use.isMobile,
    hasTouch: info.project.use.hasTouch,
  });
  try {
    const owner = await context.newPage();
    await owner.goto(`${APP_URL}${link}`);
    await owner.waitForURL((url) => url.pathname.startsWith("/businesses"));
    await owner.goto(`${APP_URL}/businesses`);
    await expect(owner.getByText("Summit Roofing").first()).toBeVisible();
    await expect(owner.getByText(/Evergreen/)).toHaveCount(0);
    await noSideScroll(owner);
    expect((await owner.goto(`${APP_URL}/businesses/${EVERGREEN}`))?.status()).toBe(404);
    // Managing logins is not theirs (the setting is off by default).
    expect((await owner.goto(`${APP_URL}/businesses/${SUMMIT}/people`))?.status()).toBe(404);
    expect((await owner.goto(`${APP_URL}/people`))?.status()).not.toBe(500);
    await expect(owner.getByRole("form", { name: "Add a person" })).toHaveCount(0);
    await owner.goto(`${APP_URL}/businesses/${SUMMIT}`);
    await expect(owner.getByText("Summit Roofing").first()).toBeVisible();

    // The admin removes the login.
    await row.getByRole("button", { name: "Remove" }).click();
    await row.getByRole("button", { name: "Confirm removal" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Access removed" })).toBeVisible();
    await expect(rows.filter({ hasText: email })).toHaveCount(0);

    // The owner's very next request is turned away, with the session cookie still in place.
    await owner.goto(`${APP_URL}/businesses/${SUMMIT}`);
    await owner.waitForURL((url) => url.pathname === "/sign-in");
    expect(new URL(owner.url()).searchParams.get("error")).toBe("no_access");
    // The old link does not let them back in either.
    await owner.goto(`${APP_URL}${link}`);
    await owner.waitForURL((url) => url.pathname === "/sign-in");
    expect(new URL(owner.url()).searchParams.get("error")).toBe("no_access");
  } finally {
    await context.close();
  }
});

test("the agency's people: admins add and remove, never themselves; members only read", async ({
  page,
}, info) => {
  const email = `teammate-${info.project.name}@brightline.test`;
  await signIn(page, "admin@brightline.test");
  await page.goto(`${APP_URL}/people`);
  const rows = page.getByTestId("person-row");
  const self = rows.filter({ hasText: "admin@brightline.test" });
  await expect(self).toContainText("(you)");
  await expect(self.getByRole("button", { name: "Remove" })).toHaveCount(0);
  await expect(self.getByRole("combobox")).toHaveCount(0);
  await noSideScroll(page);

  const form = page.getByRole("form", { name: "Add a person" });
  await form.getByLabel("Email").fill(email);
  await form.getByLabel("Role").selectOption("agency_member");
  await form.getByRole("button", { name: "Add and invite" }).click();
  const row = rows.filter({ hasText: email });
  await expect(row).toHaveCount(1);
  // Adding the same address again says so, inside this agency only.
  await form.getByLabel("Email").fill(email);
  await form.getByRole("button", { name: "Add and invite" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "already on the agency" })).toBeVisible();
  await row.getByRole("combobox").selectOption("agency_admin");
  await expect(page.getByRole("status").filter({ hasText: "Role changed" })).toBeVisible();
  await row.getByRole("button", { name: "Remove" }).click();
  await row.getByRole("button", { name: "Confirm removal" }).click();
  await expect(rows.filter({ hasText: email })).toHaveCount(0);
  await noSideScroll(page);

  // The audit log names who did it.
  await page.goto(`${APP_URL}/audit?action=agency_membership.`);
  const latest = page.getByTestId("audit-row").first();
  await expect(latest).toContainText("agency_membership.revoke");
  // The actor is the signed-in admin (the demo admin's name).
  await expect(latest).toContainText("Avery Admin");
  // The person removed is no longer on the team, so no address is shown for them.
  await expect(latest).toContainText("a person no longer on the team");
  await expect(latest).not.toContainText(email);

  // A member sees the team and no controls.
  await page.context().clearCookies();
  await signIn(page, "member@brightline.test");
  await page.goto(`${APP_URL}/people`);
  await expect(rows.filter({ hasText: "admin@brightline.test" })).toHaveCount(1);
  await expect(page.getByRole("form", { name: "Add a person" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove" })).toHaveCount(0);
  await expect(page.getByText("Only agency admins add people")).toBeVisible();
  await noSideScroll(page);
});
