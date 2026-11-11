import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ALLOWED_DEPENDENCIES } from "../boundaries.mjs";
import { findCycle, findViolations, readWorkspace } from "./check-boundaries.mjs";

const pkg = (name, deps = []) => ({ name, dir: `packages/${name.replace("@repo/", "")}`, deps });

test("the repository itself has no boundary violations", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const packages = readWorkspace(root);
  assert.ok(packages.length >= 20, "expected the scaffolded workspace packages to be found");
  assert.deepEqual(findViolations(packages, ALLOWED_DEPENDENCIES), []);
});

test("the allowed graph itself is layered: no package may depend on one that may depend on it", () => {
  const asPackages = Object.entries(ALLOWED_DEPENDENCIES)
    .filter(([, deps]) => deps !== "*")
    .map(([name, deps]) => pkg(name, [...deps]));
  assert.equal(findCycle(asPackages), null);
});

test("core has no workspace dependencies, so it stays safe to import anywhere", () => {
  assert.deepEqual(ALLOWED_DEPENDENCIES["@repo/core"], []);
});

test("the engine cannot import the packages that plug into it", () => {
  for (const forbidden of ["@repo/knowledge", "@repo/leads", "@repo/pipeline", "@repo/handoff"]) {
    assert.ok(!ALLOWED_DEPENDENCIES["@repo/ai"].includes(forbidden), forbidden);
  }
});

test("a forbidden dependency is reported with the allowed list", () => {
  const allowed = { "@repo/core": [], "@repo/db": ["@repo/core"] };
  const problems = findViolations(
    [pkg("@repo/core", ["@repo/db"]), pkg("@repo/db", ["@repo/core"])],
    allowed,
  );
  assert.equal(problems.length, 2);
  assert.match(problems[0], /@repo\/core may not depend on @repo\/db\. Allowed: \(none\)/);
  assert.match(problems[1], /dependency cycle: @repo\/core -> @repo\/db -> @repo\/core/);
});

test("an unregistered package is reported", () => {
  const problems = findViolations([pkg("@repo/core"), pkg("@repo/mystery", ["@repo/core"])], {
    "@repo/core": [],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /@repo\/mystery .* is not registered in tooling\/boundaries\.mjs/);
});

test("a registered package that does not exist is reported", () => {
  const problems = findViolations([pkg("@repo/core")], { "@repo/core": [], "@repo/ghost": [] });
  assert.deepEqual(problems, [
    "tooling/boundaries.mjs lists @repo/ghost, but no such workspace package exists",
  ]);
});

test("a dependency on a package outside the workspace scope list is reported", () => {
  const problems = findViolations([pkg("@repo/core", ["@repo/nope"])], { "@repo/core": [] });
  assert.deepEqual(problems, [
    "@repo/core depends on @repo/nope, which is not a workspace package",
  ]);
});

test("the wildcard rule allows any workspace dependency", () => {
  const allowed = { "@repo/core": [], "@repo/web": "*" };
  assert.deepEqual(
    findViolations([pkg("@repo/core"), pkg("@repo/web", ["@repo/core"])], allowed),
    [],
  );
});
