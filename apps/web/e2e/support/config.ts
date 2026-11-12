import path from "node:path";

/** Ports, origins and the state file shared by the Playwright config, the servers and the specs. */
export const APP_PORT = 3100;
export const APP_URL = `http://127.0.0.1:${APP_PORT}`;
/** The sample business website, on the widget's allowed list. */
export const SITE_PORT = 4173;
export const SITE_URL = `http://127.0.0.1:${SITE_PORT}`;
/** The same page from an origin that is not on the list. */
export const OTHER_SITE_PORT = 4174;
export const OTHER_SITE_URL = `http://127.0.0.1:${OTHER_SITE_PORT}`;

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
/** Written by the app server's start-up script, read by the sample site and the specs. */
export const STATE_FILE = path.join(REPO_ROOT, ".local", "e2e", "state.json");

export interface E2eState {
  readonly databaseUrl: string;
  readonly agencyId: string;
  readonly businessId: string;
  readonly businessName: string;
  readonly widgetKey: string;
}
