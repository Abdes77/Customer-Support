import { describe, expect, it } from "vitest";

import {
  AppError,
  ConfigError,
  ExternalServiceError,
  isRetryable,
  safeErrorMessage,
  safeErrorStack,
  scrubQueryError,
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

describe("errors of failed database statements", () => {
  // What the database library throws: the statement, then the values it was given.
  function queryError(values: string): Error {
    const error = new Error(
      `Failed query: insert into "messages" ("text") values ($1)\nparams: ${values}`,
    );
    (error as { params?: unknown }).params = [values];
    return error;
  }

  it("lose the statement's values in the message and in the stack", () => {
    const values = "My husband fell off the roof,\n    at fake (frame:1:2)\njane@example.com";
    const error = queryError(values);
    expect(safeErrorMessage(error.message)).toBe(
      'Failed query: insert into "messages" ("text") values ($1)\nparams: [removed]',
    );
    const stack = safeErrorStack(error.stack, error.message) ?? "";
    expect(stack).not.toContain("husband");
    expect(stack).not.toContain("fake (frame");
    // The real frames are still there.
    expect(stack).toMatch(/\n\s+at /);
  });

  it("are scrubbed in place, down the chain of causes, and stay the same objects", () => {
    const inner = queryError("secret words");
    const outer = new TenantAccessError("refused", { cause: inner });
    expect(scrubQueryError(outer)).toBe(outer);
    expect(outer.cause).toBe(inner);
    expect(inner.message).not.toContain("secret words");
    expect(inner.stack ?? "").not.toContain("secret words");
    expect((inner as { params?: unknown }).params).toEqual([]);
  });

  it("leave every other message alone", () => {
    expect(safeErrorMessage("params: 1\nFailed query: no")).toBe("params: 1\nFailed query: no");
    expect(safeErrorMessage("Twilio refused the message (HTTP 400).")).toBe(
      "Twilio refused the message (HTTP 400).",
    );
    const plain = new Error("plain");
    expect(safeErrorStack(plain.stack, plain.message)).toBe(plain.stack);
    expect(scrubQueryError("not an error")).toBe("not an error");
  });
});
