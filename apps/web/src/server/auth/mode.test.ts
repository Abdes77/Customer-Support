import { describe, expect, it } from "vitest";

import { type DeploymentInfo, loadEnv } from "@repo/core/env";

import { resolveAuthMode } from "./mode";

const local: DeploymentInfo = { environment: "local", commitSha: null, region: null };
const secret = "s".repeat(40);
const supabase = {
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
};

describe("resolveAuthMode", () => {
  it("is unconfigured when nothing is set", () => {
    expect(resolveAuthMode(loadEnv({}), local)).toBe("unconfigured");
  });

  it("uses Supabase when the project URL and anon key are set", () => {
    expect(resolveAuthMode(loadEnv(supabase), local)).toBe("supabase");
  });

  it("does not treat the placeholder URL from .env.example as a configured project", () => {
    const env = loadEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://your-project.supabase.co" });
    expect(resolveAuthMode(env, local)).toBe("unconfigured");
  });

  it("uses the local sign-in on a developer machine when its secret is set", () => {
    expect(resolveAuthMode(loadEnv({ LOCAL_AUTH_SECRET: secret }), local)).toBe("local");
  });

  it("prefers Supabase when both are configured", () => {
    expect(resolveAuthMode(loadEnv({ ...supabase, LOCAL_AUTH_SECRET: secret }), local)).toBe(
      "supabase",
    );
  });

  it.each(["production", "preview", "development"] as const)(
    "never uses the local sign-in on Vercel (%s)",
    (environment) => {
      const deployment: DeploymentInfo = { environment, commitSha: "abc", region: "iad1" };
      expect(resolveAuthMode(loadEnv({ LOCAL_AUTH_SECRET: secret }), deployment)).toBe(
        "unconfigured",
      );
    },
  );
});
