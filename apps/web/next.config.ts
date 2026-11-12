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

const nextConfig: NextConfig = {
  transpilePackages: workspacePackages,
  // The IMAP and SMTP clients (C11) load parts of themselves at run time (worker threads,
  // optional modules): run them from node_modules instead of bundling them.
  serverExternalPackages: ["imapflow", "nodemailer"],
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,
};

export default nextConfig;
