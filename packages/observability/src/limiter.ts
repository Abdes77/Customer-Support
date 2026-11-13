/**
 * A fixed-window rate limiter held in memory, for the public routes' first line of defence
 * (C17: the website chat's `config` and `session` calls, counted per address before the
 * database is reached). It is per process: on a serverless platform each instance counts on
 * its own, so it bounds what one instance does, not the whole deployment; the per-address,
 * per-session and per-business limits in PostgreSQL (C8) and a platform firewall rule
 * (HUMAN_TODO 19) are the deployment-wide ones.
 */

export interface MemoryRateLimiter {
  /** Counts one request for `key`; `allowed` is false once the window's limit is passed. */
  hit(key: string): {
    readonly allowed: boolean;
    readonly count: number;
    readonly retryAfterSeconds: number;
  };
  /** How many keys are tracked (bounded by `maxKeys`). */
  size(): number;
}

export function createMemoryRateLimiter(options: {
  readonly limit: number;
  readonly windowMs: number;
  /** Older windows are forgotten first once this many keys are tracked. Default 10,000. */
  readonly maxKeys?: number;
  readonly now?: () => number;
}): MemoryRateLimiter {
  const now = options.now ?? (() => Date.now());
  const maxKeys = options.maxKeys ?? 10_000;
  const windows = new Map<string, { start: number; count: number }>();

  function prune(current: number): void {
    for (const [key, entry] of windows) {
      if (entry.start + options.windowMs <= current) windows.delete(key);
    }
    // Still too many live windows: forget the oldest (Map keeps insertion order).
    while (windows.size >= maxKeys) {
      const oldest = windows.keys().next();
      if (oldest.done === true) break;
      windows.delete(oldest.value);
    }
  }

  return {
    hit(key) {
      const current = now();
      const start = Math.floor(current / options.windowMs) * options.windowMs;
      let entry = windows.get(key);
      if (entry?.start !== start) {
        if (entry === undefined && windows.size >= maxKeys) prune(current);
        entry = { start, count: 0 };
        windows.delete(key);
        windows.set(key, entry);
      }
      entry.count += 1;
      return {
        allowed: entry.count <= options.limit,
        count: entry.count,
        retryAfterSeconds: Math.max(1, Math.ceil((start + options.windowMs - current) / 1000)),
      };
    },
    size: () => windows.size,
  };
}
