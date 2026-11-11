import { describe, expect, it } from "vitest";

import {
  AppError,
  ConfigError,
  ExternalServiceError,
  isRetryable,
  TenantAccessError,
  ValidationError,
} from "./errors";

describe("AppError", () => {
  it("keeps code, cause and safe details, and is not retryable by default", () => {
    const cause = new Error("root");
    const error = new ValidationError("bad input", { cause, details: { field: "zip" } });
    expect(error).toBeInstanceOf(AppError);
    expect(error.name).toBe("ValidationError");
    expect(error.code).toBe("validation_failed");
    expect(error.cause).toBe(cause);
    expect(error.details).toEqual({ field: "zip" });
    expect(error.retryable).toBe(false);
  });

  it("never retries configuration or tenant-boundary failures", () => {
    expect(isRetryable(new ConfigError("missing key"))).toBe(false);
    expect(isRetryable(new TenantAccessError("wrong business"))).toBe(false);
  });
});

describe("ExternalServiceError", () => {
  it.each([
    [undefined, true, "external_service_failed"],
    [408, true, "external_service_failed"],
    [429, true, "rate_limited"],
    [500, true, "external_service_failed"],
    [503, true, "external_service_failed"],
    [400, false, "external_service_failed"],
    [401, false, "external_service_failed"],
    [404, false, "external_service_failed"],
  ] as const)("status %s -> retryable %s, code %s", (status, retryable, code) => {
    const error = new ExternalServiceError("failed", {
      provider: "meta",
      ...(status === undefined ? {} : { status }),
    });
    expect(error.retryable).toBe(retryable);
    expect(error.code).toBe(code);
    expect(error.provider).toBe("meta");
  });

  it("lets the caller override the retry decision and carries retry-after", () => {
    const error = new ExternalServiceError("permanent 500", {
      provider: "hubspot",
      status: 500,
      retryable: false,
      retryAfterSeconds: 30,
    });
    expect(error.retryable).toBe(false);
    expect(error.retryAfterSeconds).toBe(30);
  });
});

describe("isRetryable", () => {
  it("treats unknown errors as transient so jobs retry them", () => {
    expect(isRetryable(new Error("boom"))).toBe(true);
    expect(isRetryable("string failure")).toBe(true);
  });
});
