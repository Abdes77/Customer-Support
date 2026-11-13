import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * BUILD_PLAN: "the main entry point free of server imports so the browser can import the
 * registry". ESLint forbids the imports file by file; this test checks the whole graph that
 * `@repo/settings` pulls in, so an indirect import cannot slip through either.
 */

const SRC = import.meta.dirname;

/** The module specifiers a file imports or re-exports, read with the TypeScript scanner. */
function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return ts.preProcessFile(source, true, true).importedFiles.map((imported) => imported.fileName);
}

function resolveRelative(from: string, specifier: string): string {
  const base = path.resolve(path.dirname(from), specifier);
  for (const candidate of [`${base}.ts`, path.join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Cannot resolve ${specifier} from ${from}`);
}

function graph(entry: string): { files: string[]; packages: string[] } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of importsOf(file)) {
      if (specifier.startsWith(".")) queue.push(resolveRelative(file, specifier));
      else packages.add(specifier);
    }
  }
  return {
    files: [...files].map((file) => path.relative(SRC, file)).sort(),
    packages: [...packages].sort(),
  };
}

describe("entry points", () => {
  it("@repo/settings imports nothing but zod and @repo/core, and no server file", () => {
    const main = graph(path.join(SRC, "index.ts"));
    expect(main.packages).toEqual(["@repo/core", "zod"]);
    expect(main.files.filter((file) => file.startsWith("server"))).toEqual([]);
    // The walk really followed the graph.
    expect(main.files).toContain(path.join("registry", "qualification.ts"));
    expect(main.files).toContain("resolve.ts");
    expect(main.files.length).toBeGreaterThan(30);
  });

  it("@repo/settings/server is where the database comes in", () => {
    const server = graph(path.join(SRC, "server", "index.ts"));
    expect(server.packages).toEqual(["@repo/core", "@repo/db", "zod"]);
  });

  it("the package exports exactly these two entry points", () => {
    const manifest = JSON.parse(readFileSync(path.join(SRC, "..", "package.json"), "utf8")) as {
      exports: Record<string, string>;
    };
    expect(manifest.exports).toEqual({
      ".": "./src/index.ts",
      "./server": "./src/server/index.ts",
    });
  });
});
