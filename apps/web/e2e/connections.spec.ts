import { readFileSync } from "node:fs";

import { expect, type Page, test } from "@playwright/test";

import { DEMO } from "@repo/db/seed";

import { APP_URL, type E2eState, SITE_URL, STATE_FILE } from "./support/config";

/*
 * Every connection page (C16) in a real browser at desktop and phone widths, as an agency
 * admin. This machine has no vendor account, so the e2e server has Meta's webhook secrets but
 * no signup or login configuration, no Google or Microsoft app and no CRM app; the start-up
 * script stores connections in the states the connect flows leave behind (connected, needs
 * reconnecting, error with the provider's reason). Each page must show exactly that, offer
 * what this deployment can do, and say plainly what it cannot.
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

test("the channels page shows each channel's stored state", async ({ page }) => {
  const { businessId, widgetKey } = state();
  await signIn(page, "admin@brightline.test");
  await page.goto(`${APP_URL}/businesses/${businessId}`);
  await page.getByRole("link", { name: "Channels" }).click();
  await page.waitForURL(/\/channels$/);

  // Website chat: the snippet with the business's key, the allowed site, on and off.
  const widget = page.getByTestId("channel-widget");
  await expect(widget.getByTestId("copy-value")).toContainText(`data-key="${widgetKey}"`);
  await expect(widget).toContainText(SITE_URL);
  await expect(widget).toContainText("Connected");
  await widget.getByRole("button", { name: "Turn the chat off" }).click();
  await expect(widget).toContainText("Disconnected");
  await widget.getByRole("button", { name: "Turn the chat on" }).click();
  await expect(widget).toContainText("Connected");

  // WhatsApp: the stored number, connected; Embedded Signup is not configured here.
  const whatsapp = page.getByTestId("channel-whatsapp");
  await expect(whatsapp.getByTestId("whatsapp-number")).toContainText("+1 303-555-0100");
  await expect(whatsapp.getByTestId("whatsapp-number")).toContainText("Connected");
  await expect(whatsapp.getByTestId("not-configured")).toContainText("Embedded Signup");
  await expect(whatsapp.getByRole("button", { name: "Connect a WhatsApp number" })).toHaveCount(0);

  // Messenger: the Page needs reconnecting, with the reason Meta gave.
  const meta = page.getByTestId("channel-meta");
  await expect(meta.getByTestId("meta-connection")).toContainText("Summit Roofing Co. Page");
  await expect(meta.getByTestId("meta-connection")).toContainText("Needs reconnecting");
  await expect(meta.getByTestId("connection-error")).toContainText("connect it again");
  await expect(meta.getByTestId("not-configured")).toContainText("Facebook Login");

  // Email: an IMAP inbox in error with its reason; no Google or Microsoft app on this server.
  const email = page.getByTestId("channel-email");
  await expect(email.getByTestId("email-inbox")).toContainText("office@summitroofing.example.com");
  await expect(email.getByTestId("email-inbox")).toContainText("Error");
  await expect(email.getByTestId("connection-error")).toContainText("authentication failed");
  await expect(email.getByTestId("not-configured")).toContainText("Gmail and Microsoft 365");
  await expect(email.getByRole("button", { name: "Connect Gmail" })).toHaveCount(0);
  await email.getByText("Connect an IMAP/SMTP inbox").click();
  await expect(email.getByTestId("imap-form").getByLabel("IMAP server")).toBeVisible();
  // Nothing secret on the page.
  expect(await page.content()).not.toMatch(/EAAG|e2e-imap-password|hcp-key/);
  await noSideScroll(page);

  // A business with nothing connected says so.
  await page.goto(`${APP_URL}/businesses/${DEMO.businesses.hvac}/channels`);
  await expect(page.getByTestId("channel-whatsapp")).toContainText("No number connected.");
  await expect(page.getByTestId("channel-email")).toContainText("No inbox connected.");
  await noSideScroll(page);
});

test("the integrations page shows calendars, CRMs, webhooks and alerts", async ({ page }) => {
  const { businessId } = state();
  await signIn(page, "admin@brightline.test");
  await page.goto(`${APP_URL}/businesses/${businessId}/integrations`);

  const calendars = page.getByTestId("integration-calendars");
  await expect(calendars.getByTestId("calendar-connection")).toContainText("Google Calendar");
  await expect(calendars.getByTestId("calendar-connection")).toContainText("Connected");
  await expect(calendars.getByTestId("not-configured")).toBeVisible();

  const crms = page.getByTestId("integration-crms");
  const housecall = crms.getByTestId("crm-housecall_pro");
  await expect(housecall).toContainText("Error");
  await expect(housecall.getByTestId("connection-error")).toContainText("answered with an error");
  const hubspot = crms.getByTestId("crm-hubspot");
  await expect(hubspot).toContainText("Not connected");
  // The field mapping and a preview with a real lead of this business.
  await hubspot.getByText(/Field mapping/).click();
  await expect(hubspot.getByRole("table")).toContainText("email");
  await hubspot.getByRole("button", { name: "Preview" }).click();
  await expect(hubspot.getByTestId("mapping-preview")).toBeVisible();

  const webhooks = page.getByTestId("integration-webhooks");
  await expect(webhooks.getByTestId("webhook-target")).toContainText("e2e-zapier");
  // The signing secret, for an agency admin on request only.
  await expect(webhooks.getByTestId("webhook-secret")).toHaveCount(0);
  await webhooks.getByRole("button", { name: "Show secret" }).click();
  await expect(webhooks.getByTestId("webhook-secret")).toContainText("whsec_");
  await webhooks.getByRole("button", { name: "Hide secret" }).click();
  await expect(webhooks.getByTestId("webhook-secret")).toHaveCount(0);

  await expect(page.getByTestId("integration-alerts")).toContainText("Manage alert contacts");
  await noSideScroll(page);
});

test("an agency member sees no signing secret, and a client user no connection page", async ({
  page,
}) => {
  const { businessId } = state();
  await signIn(page, "member@brightline.test");
  await page.goto(`${APP_URL}/businesses/${businessId}/integrations`);
  await expect(
    page.getByTestId("integration-webhooks").getByTestId("webhook-target"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Show secret" })).toHaveCount(0);
  await page.context().clearCookies();
  await signIn(page, "owner@summitroofing.test");
  for (const path of ["channels", "integrations"]) {
    const response = await page.goto(`${APP_URL}/businesses/${businessId}/${path}`);
    expect(response?.status()).toBe(404);
  }
});
