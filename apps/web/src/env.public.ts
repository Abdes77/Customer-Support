/**
 * Browser-visible configuration. Next.js inlines `process.env.NEXT_PUBLIC_*` at build time
 * only when each variable is written out in full, so this is the one file in the app that
 * reads `process.env` directly. Server code uses `getEnv()` from `@repo/core/env`.
 *
 * Every variable here must also be declared in packages/core/src/env/spec.ts.
 */
export const publicEnv = {
  appUrl: process.env.NEXT_PUBLIC_APP_URL,
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  metaAppId: process.env.NEXT_PUBLIC_META_APP_ID,
  sentryDsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
} as const;
