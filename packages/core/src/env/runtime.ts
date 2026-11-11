/**
 * Variables that the platform sets, not a person: NODE_ENV and Vercel's system variables.
 * They are not in the env spec (nobody has to obtain them), so they are read here, once.
 */
export type NodeEnv = "development" | "test" | "production";

export function nodeEnv(
  source: Readonly<Record<string, string | undefined>> = process.env,
): NodeEnv {
  const value = source["NODE_ENV"];
  return value === "production" || value === "test" ? value : "development";
}

export function isProduction(
  source: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return nodeEnv(source) === "production";
}

export interface DeploymentInfo {
  /** Vercel environment, or "local" when not running on Vercel. */
  readonly environment: "production" | "preview" | "development" | "local";
  readonly commitSha: string | null;
  readonly region: string | null;
}

export function deploymentInfo(
  source: Readonly<Record<string, string | undefined>> = process.env,
): DeploymentInfo {
  const vercelEnv = source["VERCEL_ENV"];
  return {
    environment:
      vercelEnv === "production" || vercelEnv === "preview" || vercelEnv === "development"
        ? vercelEnv
        : "local",
    commitSha: source["VERCEL_GIT_COMMIT_SHA"] ?? null,
    region: source["VERCEL_REGION"] ?? null,
  };
}
