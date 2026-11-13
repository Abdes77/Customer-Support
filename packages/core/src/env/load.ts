import type { z } from "zod";

import { ConfigError } from "../errors";
import { ENV_NAMES, ENV_SPEC, type EnvName, type EnvVarSpec } from "./spec";

type ValueOf<TName extends EnvName> = z.infer<(typeof ENV_SPEC)[TName]["schema"]>;

/** Parsed environment. Variables without a declared default are `undefined` when unset. */
export type Env = {
  readonly [TName in EnvName]: (typeof ENV_SPEC)[TName] extends { readonly default: string }
    ? ValueOf<TName>
    : ValueOf<TName> | undefined;
};

export type EnvSource = Readonly<Record<string, string | undefined>>;

const HUMAN_TODO_HINT = "See docs/HUMAN_TODO.md for where to get each value.";

/**
 * Parses and validates environment variables. Unset and empty variables are treated the same.
 * Throws one ConfigError naming every malformed variable; values never appear in the message.
 */
export function loadEnv(source: EnvSource): Env {
  const parsed: Record<string, unknown> = {};
  const problems: string[] = [];

  for (const name of ENV_NAMES) {
    const spec: EnvVarSpec = ENV_SPEC[name];
    const raw = source[name];
    const value = raw === undefined || raw.trim() === "" ? spec.default : raw.trim();
    if (value === undefined) {
      parsed[name] = undefined;
      continue;
    }
    const result = spec.schema.safeParse(value);
    if (result.success) {
      parsed[name] = result.data;
    } else {
      const reason = result.error.issues.map((issue) => issue.message).join("; ");
      problems.push(`${name} (${reason})`);
    }
  }

  if (problems.length > 0) {
    throw new ConfigError(
      `Invalid environment variables: ${problems.join(", ")}. ${HUMAN_TODO_HINT}`,
      { details: { variables: problems.map((problem) => problem.split(" ")[0]) } },
    );
  }
  return parsed as Env;
}

let cached: Env | undefined;

/** The process environment, parsed once. Server code only. */
export function getEnv(): Env {
  cached ??= loadEnv(process.env);
  return cached;
}

/** Forget the cached environment. For tests that change `process.env`. */
export function resetEnvCache(): void {
  cached = undefined;
}

/** True when every named variable is set. Use it to choose between a live client and a mock. */
export function hasEnv(env: Env, ...names: readonly EnvName[]): boolean {
  return names.every((name) => env[name] !== undefined);
}

/**
 * Returns the named variables, all guaranteed present, or throws a ConfigError that lists
 * every missing one. Call it at the point of use, so an unconfigured integration fails with a
 * clear message instead of an undefined token deep inside a vendor SDK.
 */
export function requireEnv<const TNames extends readonly EnvName[]>(
  env: Env,
  ...names: TNames
): { readonly [TName in TNames[number]]: NonNullable<Env[TName]> } {
  const missing = names.filter((name) => env[name] === undefined);
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing environment variables: ${missing.join(", ")}. ${HUMAN_TODO_HINT}`,
      { details: { variables: missing } },
    );
  }
  return Object.fromEntries(names.map((name) => [name, env[name]])) as {
    readonly [TName in TNames[number]]: NonNullable<Env[TName]>;
  };
}

/** Names of the variables the product cannot run without that are currently unset. */
export function missingProductionEnv(env: Env): EnvName[] {
  return ENV_NAMES.filter(
    (name) => (ENV_SPEC[name] as EnvVarSpec).required === "production" && env[name] === undefined,
  );
}
