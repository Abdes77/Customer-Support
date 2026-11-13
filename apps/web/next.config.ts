import path from "node:path";

import type { NextConfig } from "next";

import packageJson from "./package.json" with { type: "json" };

// Configuration lives in one `.env.local` at the repository root (see .env.example), shared
// with the `pnpm db:*` scripts. Next.js only reads env files next to the app, so load the
// root ones here. Variables that are already set win; on Vercel the files do not exist.
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(path.resolve(import.meta.dirname, "../..", file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Workspace packages export TypeScript source, so Next.js has to transpile them. */
const workspacePackages = Object.keys(packageJson.dependencies).filter((name) =>
  name.startsWith("@repo/"),
);

/**
 * Headers on every response (C17 audit). No page of this app is meant to be shown inside
 * another site's frame: the admin panel's buttons (take over, release, pause a business,
 * rotate a secret) must not be clickable through one, whatever the session cookie's SameSite
 * rule is in a given browser. The website chat is a script on the customer's page, not a
 * frame, so it is not affected. Responses also never have their type guessed, and a link out
 * of the panel tells the other site our origin at most, never a conversation's address.
 * Routes that set a stricter policy of their own (customer files, the acknowledgement page)
 * keep it.
 */
export const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
] as const;

const nextConfig: NextConfig = {
  headers: async () => [{ source: "/:path*", headers: [...SECURITY_HEADERS] }],
  transpilePackages: workspacePackages,
  // The IMAP and SMTP clients (C11) load parts of themselves at run time (worker threads,
  // optional modules): run them from node_modules instead of bundling them.
  serverExternalPackages: ["imapflow", "nodemailer"],
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,
  // Out of the way of the admin panel's sidebar (sign-out sits bottom left).
  devIndicators: { position: "bottom-right" },
  experimental: {
    // The admin panel's CSV upload (C15) sends the file as text through a server action:
    // room for 3.5 MB of CSV, under Vercel's 4.5 MB request limit.
    serverActions: { bodySizeLimit: "4mb" },
  },
};

export default nextConfig;
