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
 * Other names a value may arrive under. Supabase's integration on Vercel sets its own names
 * on the project it is connected to (its database strings, and the newer publishable and
 * secret keys in place of the anon and service-role ones); with these the integration alone
 * configures the database, sign-in and storage. The spec's own name wins when both are set.
 */
export const ENV_ALIASES: Readonly<Partial<Record<EnvName, readonly string[]>>> = {
  DATABASE_URL: ["POSTGRES_URL"],
  DATABASE_URL_DIRECT: ["POSTGRES_URL_NON_POOLING"],
  NEXT_PUBLIC_SUPABASE_URL: ["SUPABASE_URL"],
  NEXT_PUBLIC_SUPABASE_ANON_KEY: [
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_PUBLISHABLE_KEY",
  ],
  SUPABASE_SERVICE_ROLE_KEY: ["SUPABASE_SECRET_KEY"],
};

/** The value of the first of these names that is set to something. */
function firstSet(source: EnvSource, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = source[name]?.trim();
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

/**
 * Parses and validates environment variables. Unset and empty variables are treated the same.
 * Throws one ConfigError naming every malformed variable; values never appear in the message.
 */
export function loadEnv(source: EnvSource): Env {
  const parsed: Record<string, unknown> = {};
  const problems: string[] = [];

  for (const name of ENV_NAMES) {
    const spec: EnvVarSpec = ENV_SPEC[name];
    const value = firstSet(source, [name, ...(ENV_ALIASES[name] ?? [])]) ?? spec.default;
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
