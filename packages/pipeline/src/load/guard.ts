import { DEFAULT_TEST_DATABASE_URL } from "@repo/db/testing";

/**
 * The load test (C18) writes thousands of rows. It only ever runs in a throwaway database it
 * creates itself (`createTestDatabase()`, cloned on the server of `TEST_DATABASE_URL` and
 * dropped at the end), and this check refuses every setting in which that server could be a
 * hosted one: a production build, a Vercel environment, a database server that is not this
 * machine, or a test server that is the same as `DATABASE_URL`'s.
 */
export function loadTestRefusal(
  source: Readonly<Record<string, string | undefined>>,
): string | null {
  if (source["NODE_ENV"] === "production") return "NODE_ENV is production.";
  if (source["VERCEL_ENV"] !== undefined) return "VERCEL_ENV is set: this is a deployment.";
  const target = source["TEST_DATABASE_URL"] ?? DEFAULT_TEST_DATABASE_URL;
  let host: string;
  try {
    host = new URL(target).hostname;
  } catch {
    return "TEST_DATABASE_URL is not a URL.";
  }
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) {
    return `The test database server (${host}) is not this machine: the load test runs only against local PostgreSQL (pnpm services:up).`;
  }
  const production = source["DATABASE_URL"];
  if (production !== undefined) {
    try {
      const a = new URL(production);
      const b = new URL(target);
      if (a.host === b.host && a.pathname === b.pathname) {
        return "TEST_DATABASE_URL names the same database as DATABASE_URL.";
      }
    } catch {
      // An unreadable DATABASE_URL is not the test server.
    }
  }
  return null;
}
