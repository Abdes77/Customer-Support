/**
 * @repo/observability (owner: C17)
 *
 * Error reporting to Sentry (a small envelope client behind `SENTRY_DSN`, with scrubbing),
 * the log listener that reports error records, the in-memory per-address limiter of the
 * public routes, and the readiness rules. The structured logger itself lives in @repo/core;
 * the database-backed rate limits and spend caps are a turn guard of the pipeline
 * (`packages/pipeline/src/limits`), because this layer cannot reach the database.
 */
export * from "./limiter";
export * from "./readiness";
export * from "./reporting";
export * from "./scrub";
export * from "./sentry";
