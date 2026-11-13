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
  /**
   * Vercel's environment; "production" for a production build anywhere else (a self-hosted
   * `next start`), unless `DEVELOPMENT_MODE=1` asks for development; "local" for a developer
   * machine, tests and scripts. Development conveniences (in-process jobs, the offline model,
   * local sign-in and storage, per-process secrets for the test channel and the widget) are
   * only ever switched on for "local".
   */
  readonly environment: "production" | "preview" | "development" | "local";
  readonly commitSha: string | null;
  readonly region: string | null;
}

/**
 * Where this process runs. Production is the default for a production build: a self-hosted
 * deployment gets the same safe behaviour as Vercel production (no test channel without its
 * secret, no in-process job runner, no offline model, no local sign-in or storage) unless
 * `DEVELOPMENT_MODE=1` explicitly opts in, as the browser tests do. A production build that
 * opts in while others can reach it fails the readiness check (`/api/health/ready`, C17).
 */
export function deploymentInfo(
  source: Readonly<Record<string, string | undefined>> = process.env,
): DeploymentInfo {
  const vercelEnv = source["VERCEL_ENV"];
  const environment =
    vercelEnv === "production" || vercelEnv === "preview" || vercelEnv === "development"
      ? vercelEnv
      : nodeEnv(source) === "production" && !developmentModeRequested(source)
        ? "production"
        : "local";
  return {
    environment,
    commitSha: source["VERCEL_GIT_COMMIT_SHA"] ?? null,
    region: source["VERCEL_REGION"] ?? null,
  };
}

/** True when `DEVELOPMENT_MODE=1` asks a production build off Vercel to run as development. */
export function developmentModeRequested(
  source: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return source["DEVELOPMENT_MODE"]?.trim() === "1" && source["VERCEL_ENV"] === undefined;
}

/** True for a URL on this machine only (localhost, 127.0.0.1, ::1). */
export function isLoopbackUrl(url: string | undefined): boolean {
  if (url === undefined) return false;
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}
