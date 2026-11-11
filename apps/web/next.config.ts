import type { NextConfig } from "next";

import packageJson from "./package.json" with { type: "json" };

/** Workspace packages export TypeScript source, so Next.js has to transpile them. */
const workspacePackages = Object.keys(packageJson.dependencies).filter((name) =>
  name.startsWith("@repo/"),
);

const nextConfig: NextConfig = {
  transpilePackages: workspacePackages,
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,
};

export default nextConfig;
