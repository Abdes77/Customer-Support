import path from "node:path";

/**
 * Loads the repository's `.env.local` (then `.env`) into the process, like Next.js does for
 * the app, so `pnpm db:*` sees the same configuration. Variables that are already set win.
 * Missing files are fine: CI and production pass real environment variables.
 */
export function loadRootEnv(): void {
  const root = path.resolve(import.meta.dirname, "../../..");
  for (const file of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(path.join(root, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Prints a failure without a stack trace for expected errors, and sets the exit code. */
export function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFailed: ${message}`);
  process.exitCode = 1;
}
