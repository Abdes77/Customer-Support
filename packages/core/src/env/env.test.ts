import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ConfigError } from "../errors";
import { redact, REDACTED } from "../logger";
import { renderEnvExample } from "./example";
import { hasEnv, loadEnv, missingProductionEnv, requireEnv } from "./load";
import { ENV_GROUPS, ENV_NAMES, ENV_SPEC, type EnvVarSpec } from "./spec";

const VALID_KEY = Buffer.alloc(32, 7).toString("base64");

describe("loadEnv", () => {
  it("applies declared defaults and leaves everything else undefined", () => {
    const env = loadEnv({});
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.SUPABASE_STORAGE_BUCKET).toBe("attachments");
    expect(env.CREDENTIALS_ENCRYPTION_KEY_ID).toBe("k1");
    expect(env.MICROSOFT_TENANT_ID).toBe("common");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.APP_URL).toBeUndefined();
  });

  it("treats empty and whitespace-only values as unset", () => {
    const env = loadEnv({ ANTHROPIC_API_KEY: "", APP_URL: "   ", LOG_LEVEL: "" });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.APP_URL).toBeUndefined();
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("parses and transforms valid values", () => {
    const env = loadEnv({
      APP_URL: "https://app.example.com",
      INNGEST_DEV: "1",
      CREDENTIALS_ENCRYPTION_KEY: VALID_KEY,
      TWILIO_FROM_NUMBER: "+15555550100",
    });
    expect(env.APP_URL).toBe("https://app.example.com");
    expect(env.INNGEST_DEV).toBe(true);
    expect(env.CREDENTIALS_ENCRYPTION_KEY).toBe(VALID_KEY);
  });

  it("rejects an encryption key with characters outside the base64 alphabet", () => {
    expect(() => loadEnv({ CREDENTIALS_ENCRYPTION_KEY: `!${VALID_KEY}` })).toThrow(ConfigError);
    expect(() => loadEnv({ CREDENTIALS_ENCRYPTION_KEY: VALID_KEY.slice(0, 20) })).toThrow(
      ConfigError,
    );
  });

  it("names every malformed variable and never echoes a value", () => {
    const secretLookingValue = "not-a-32-byte-key-SECRETVALUE";
    let thrown: unknown;
    try {
      loadEnv({
        APP_URL: "not a url",
        CREDENTIALS_ENCRYPTION_KEY: secretLookingValue,
        META_GRAPH_API_VERSION: "24",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    const message = (thrown as ConfigError).message;
    expect(message).toContain("APP_URL");
    expect(message).toContain("CREDENTIALS_ENCRYPTION_KEY");
    expect(message).toContain("META_GRAPH_API_VERSION");
    expect(message).not.toContain(secretLookingValue);
    expect(message).not.toContain("not a url");
  });
});

describe("requireEnv and hasEnv", () => {
  it("returns the requested variables when all are present", () => {
    const env = loadEnv({ META_APP_ID: "123", META_APP_SECRET: "shh" });
    expect(hasEnv(env, "META_APP_ID", "META_APP_SECRET")).toBe(true);
    expect(requireEnv(env, "META_APP_ID", "META_APP_SECRET")).toEqual({
      META_APP_ID: "123",
      META_APP_SECRET: "shh",
    });
  });

  it("lists every missing variable and points to the human to-do list", () => {
    const env = loadEnv({ META_APP_ID: "123" });
    expect(hasEnv(env, "META_APP_ID", "META_APP_SECRET")).toBe(false);
    expect(() => requireEnv(env, "META_APP_ID", "META_APP_SECRET", "TWILIO_AUTH_TOKEN")).toThrow(
      /Missing environment variables: META_APP_SECRET, TWILIO_AUTH_TOKEN\. See docs\/HUMAN_TODO\.md/,
    );
  });

  it("reports the unset production variables", () => {
    const missing = missingProductionEnv(loadEnv({ APP_URL: "https://app.example.com" }));
    expect(missing).not.toContain("APP_URL");
    expect(missing).toContain("ANTHROPIC_API_KEY");
    expect(missing).toContain("DATABASE_URL");
    expect(missing).not.toContain("TWILIO_AUTH_TOKEN");
  });
});

describe("env spec", () => {
  const specs = ENV_NAMES.map((name) => [name, ENV_SPEC[name] as EnvVarSpec] as const);

  it("uses conventional names and known groups", () => {
    const groupIds = new Set<string>(ENV_GROUPS.map((group) => group.id));
    for (const [name, spec] of specs) {
      expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(groupIds.has(spec.group)).toBe(true);
      expect(spec.description.length).toBeGreaterThan(10);
    }
  });

  it("never ships an example value for a secret, except local database URLs", () => {
    for (const [name, spec] of specs) {
      if (!spec.secret) continue;
      if (name.endsWith("DATABASE_URL") || name === "DATABASE_URL_DIRECT") {
        expect(spec.example).toMatch(
          /^postgresql:\/\/hsrb:hsrb@127\.0\.0\.1:5432\/hsrb_(dev|test)$/,
        );
      } else {
        expect(spec.example, name).toBe("");
      }
    }
  });

  it("names every secret so that the logger redacts it, in env and camelCase form", () => {
    for (const [name, spec] of specs) {
      if (!spec.secret) continue;
      const camel = name.toLowerCase().replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
      expect(redact({ [name]: "value", [camel]: "value" }), name).toEqual({
        [name]: REDACTED,
        [camel]: REDACTED,
      });
    }
  });

  it("never exposes a secret to the browser", () => {
    for (const [name, spec] of specs) {
      if (name.startsWith("NEXT_PUBLIC_")) expect(spec.secret, name).toBe(false);
    }
  });

  it("has examples and defaults that pass their own schema", () => {
    for (const [name, spec] of specs) {
      for (const value of [spec.example, spec.default]) {
        if (value === undefined || value === "") continue;
        expect(spec.schema.safeParse(value).success, `${name}=${value}`).toBe(true);
      }
    }
  });
});

describe(".env.example", () => {
  it("is exactly what the spec renders (run `pnpm env:example` after changing the spec)", () => {
    const file = path.resolve(import.meta.dirname, "../../../../.env.example");
    expect(readFileSync(file, "utf8")).toBe(renderEnvExample());
  });

  it("lists every variable exactly once", () => {
    const rendered = renderEnvExample();
    for (const name of ENV_NAMES) {
      const matches = rendered.match(new RegExp(`^${name}=`, "gm")) ?? [];
      expect(matches.length, name).toBe(1);
    }
  });
});
