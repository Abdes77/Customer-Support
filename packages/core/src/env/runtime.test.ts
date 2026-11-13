import { describe, expect, it } from "vitest";

import {
  deploymentInfo,
  developmentModeRequested,
  isLoopbackUrl,
  isProduction,
  nodeEnv,
} from "./runtime";

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

describe("deploymentInfo: production is the default for a production build", () => {
  it("treats a production build off Vercel as production, not as a developer machine", () => {
    expect(deploymentInfo({ NODE_ENV: "production" }).environment).toBe("production");
    expect(
      deploymentInfo({ NODE_ENV: "production", APP_URL: "https://bot.example.com" }).environment,
    ).toBe("production");
  });

  it("runs a production build as development only when DEVELOPMENT_MODE=1 asks for it", () => {
    expect(deploymentInfo({ NODE_ENV: "production", DEVELOPMENT_MODE: "1" }).environment).toBe(
      "local",
    );
    expect(deploymentInfo({ NODE_ENV: "production", DEVELOPMENT_MODE: "0" }).environment).toBe(
      "production",
    );
    expect(deploymentInfo({ NODE_ENV: "production", DEVELOPMENT_MODE: "yes" }).environment).toBe(
      "production",
    );
    expect(developmentModeRequested({ DEVELOPMENT_MODE: "1" })).toBe(true);
  });

  it("never lets DEVELOPMENT_MODE change a Vercel deployment", () => {
    expect(
      deploymentInfo({ NODE_ENV: "production", VERCEL_ENV: "production", DEVELOPMENT_MODE: "1" })
        .environment,
    ).toBe("production");
    expect(developmentModeRequested({ VERCEL_ENV: "preview", DEVELOPMENT_MODE: "1" })).toBe(false);
  });

  it("keeps development servers, tests and scripts local", () => {
    expect(deploymentInfo({ NODE_ENV: "development" }).environment).toBe("local");
    expect(deploymentInfo({ NODE_ENV: "test" }).environment).toBe("local");
    expect(deploymentInfo({}).environment).toBe("local");
  });

  it("recognizes loopback addresses only", () => {
    expect(isLoopbackUrl("http://localhost:3100")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.1:3000")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:3000")).toBe(true);
    expect(isLoopbackUrl("https://bot.example.com")).toBe(false);
    expect(isLoopbackUrl("http://127.0.0.1.example.com")).toBe(false);
    expect(isLoopbackUrl("http://10.0.0.5")).toBe(false);
    expect(isLoopbackUrl(undefined)).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });
});
