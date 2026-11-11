#!/usr/bin/env node
/**
 * Fails when a workspace package depends on a package its layer may not import, when a
 * workspace package is not registered in tooling/boundaries.mjs, or when the graph has a cycle.
 * Usage: pnpm check:boundaries
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ALLOWED_DEPENDENCIES } from "../boundaries.mjs";

const SCOPE = "@repo/";
const WORKSPACE_DIRS = ["apps", "packages", "packages/channels"];

/**
 * @typedef {{ name: string, dir: string, deps: string[] }} WorkspacePackage
 */

/**
 * Reads every workspace package under `root`.
 * @param {string} root
 * @returns {WorkspacePackage[]}
 */
export function readWorkspace(root) {
  /** @type {WorkspacePackage[]} */
  const found = [];
  for (const base of WORKSPACE_DIRS) {
    const baseDir = path.join(root, base);
    if (!existsSync(baseDir)) continue;
    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = path.join(baseDir, entry.name, "package.json");
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      const deps = Object.keys({
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.peerDependencies,
        ...pkg.optionalDependencies,
      }).filter((dep) => dep.startsWith(SCOPE));
      found.push({ name: pkg.name, dir: path.join(base, entry.name), deps });
    }
  }
  // A manifest without a name is reported by findViolations, so sorting must not crash on it.
  return found.sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
}

/**
 * Returns one message per violation; an empty array means the graph is sound.
 * @param {WorkspacePackage[]} packages
 * @param {Record<string, readonly string[] | "*">} allowed
 * @returns {string[]}
 */
export function findViolations(packages, allowed) {
  /** @type {string[]} */
  const problems = [];
  const names = new Set(packages.map((pkg) => pkg.name));

  for (const pkg of packages) {
    if (!pkg.name?.startsWith(SCOPE)) {
      problems.push(`${pkg.dir}: package name must start with ${SCOPE} (found "${pkg.name}")`);
      continue;
    }
    const rule = allowed[pkg.name];
    if (rule === undefined) {
      problems.push(
        `${pkg.name} (${pkg.dir}) is not registered in tooling/boundaries.mjs. ` +
          "Add it with its allowed dependencies and note the decision in docs/DECISIONS.md.",
      );
      continue;
    }
    for (const dep of pkg.deps) {
      if (dep === pkg.name) {
        problems.push(`${pkg.name} depends on itself`);
      } else if (!names.has(dep)) {
        problems.push(`${pkg.name} depends on ${dep}, which is not a workspace package`);
      } else if (rule !== "*" && !rule.includes(dep)) {
        problems.push(
          `${pkg.name} may not depend on ${dep}. Allowed: ${rule.join(", ") || "(none)"}. ` +
            "See docs/ARCHITECTURE.md, Folder layout and package layers.",
        );
      }
    }
  }

  for (const name of Object.keys(allowed)) {
    if (!names.has(name)) {
      problems.push(`tooling/boundaries.mjs lists ${name}, but no such workspace package exists`);
    }
  }

  const cycle = findCycle(packages);
  if (cycle !== null) problems.push(`dependency cycle: ${cycle.join(" -> ")}`);

  return problems;
}

/**
 * @param {WorkspacePackage[]} packages
 * @returns {string[] | null} the first cycle found, as a path that ends where it starts
 */
export function findCycle(packages) {
  const graph = new Map(packages.map((pkg) => [pkg.name, pkg.deps]));
  /** @type {Map<string, "visiting" | "done">} */
  const state = new Map();
  /** @type {string[]} */
  const stack = [];

  /** @param {string} node @returns {string[] | null} */
  function visit(node) {
    if (state.get(node) === "done") return null;
    if (state.get(node) === "visiting") return [...stack.slice(stack.indexOf(node)), node];
    state.set(node, "visiting");
    stack.push(node);
    for (const dep of graph.get(node) ?? []) {
      if (dep === node) continue;
      const cycle = visit(dep);
      if (cycle !== null) return cycle;
    }
    stack.pop();
    state.set(node, "done");
    return null;
  }

  for (const name of graph.keys()) {
    const cycle = visit(name);
    if (cycle !== null) return cycle;
  }
  return null;
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const packages = readWorkspace(root);
  const problems = findViolations(packages, ALLOWED_DEPENDENCIES);
  if (problems.length > 0) {
    console.error(`Package boundary check failed (${problems.length}):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`Package boundaries OK (${packages.length} workspace packages).`);
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
