import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/*
 * The scoped transactions of `asUser()`, `forBusiness()` and `forAgency()` are confined by
 * the PostgreSQL role they run as. The one way out is to change that role (or the settings
 * that carry the tenant) from inside a callback. Nothing outside this package may do that,
 * and nothing outside it may reach for the unrestricted client.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const THIS_PACKAGE = path.join(REPO_ROOT, "packages", "db");

const FORBIDDEN: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /\bset\s+(local\s+|session\s+)?role\b/i, why: "changes the database role" },
  { pattern: /\breset\s+(role|all)\b/i, why: "leaves the restricted role" },
  { pattern: /set_config\s*\(\s*['"`]role['"`]/i, why: "changes the database role" },
  {
    pattern: /set_config\s*\(\s*['"`](app\.(agency|business)_id|request\.jwt\.claim)/i,
    why: "rewrites the tenant or the user of the transaction",
  },
  { pattern: /\bset\s+(local\s+)?session\s+authorization\b/i, why: "changes the session user" },
  {
    pattern: /@repo\/db\/src\/|packages\/db\/src\/internal/,
    why: "imports the unrestricted client",
  },
];

function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".turbo" || entry === "dist") {
      continue;
    }
    const full = path.join(directory, entry);
    if (full === THIS_PACKAGE) continue;
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    else if (/\.(ts|tsx|mts|js|mjs|sql)$/.test(entry)) found.push(full);
  }
  return found;
}

describe("the way out of a scoped transaction", () => {
  it("is not used anywhere outside packages/db", () => {
    const files = [
      ...sourceFiles(path.join(REPO_ROOT, "apps")),
      ...sourceFiles(path.join(REPO_ROOT, "packages")),
    ];
    expect(files.length).toBeGreaterThan(20);

    const violations: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const { pattern, why } of FORBIDDEN) {
        if (pattern.test(text)) {
          violations.push(`${path.relative(REPO_ROOT, file)}: ${why} (${String(pattern)})`);
        }
      }
    }
    // A failure here means code outside the data layer tries to leave its tenant scope.
    // Cross-tenant work belongs in packages/db/src/directory.ts (see the rules there).
    expect(violations).toEqual([]);
  });

  it("the package itself exports no unrestricted client", async () => {
    const exported = Object.keys(await import("./index"));
    for (const name of ["connect", "RawDatabase", "createLocalAuthStore", "createDirectory"]) {
      expect(exported, name).not.toContain(name);
    }
    expect(exported).toContain("getDatabase");
    expect(exported).toContain("createDatabase");
  });
});
