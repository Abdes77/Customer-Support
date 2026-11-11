import { describe, expect, it } from "vitest";

import { deploymentInfo, isProduction, nodeEnv } from "./runtime";

describe("nodeEnv", () => {
  it("defaults to development for unset or unknown values", () => {
    expect(nodeEnv({})).toBe("development");
    expect(nodeEnv({ NODE_ENV: "staging" })).toBe("development");
    expect(nodeEnv({ NODE_ENV: "test" })).toBe("test");
    expect(nodeEnv({ NODE_ENV: "production" })).toBe("production");
    expect(isProduction({ NODE_ENV: "production" })).toBe(true);
    expect(isProduction({ NODE_ENV: "test" })).toBe(false);
  });
});

describe("deploymentInfo", () => {
  it("reports local when not on Vercel", () => {
    expect(deploymentInfo({})).toEqual({ environment: "local", commitSha: null, region: null });
  });

  it("reads Vercel's system variables", () => {
    expect(
      deploymentInfo({
        VERCEL_ENV: "preview",
        VERCEL_GIT_COMMIT_SHA: "abc123",
        VERCEL_REGION: "iad1",
      }),
    ).toEqual({ environment: "preview", commitSha: "abc123", region: "iad1" });
  });
});
