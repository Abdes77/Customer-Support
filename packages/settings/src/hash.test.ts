import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalJson, fingerprint, jsonEqual, sha256Hex } from "./hash";

describe("sha256Hex", () => {
  it.each([
    "",
    "abc",
    "a".repeat(55),
    "a".repeat(56),
    "a".repeat(63),
    "a".repeat(64),
    "a".repeat(65),
    "héllo wörld ✓ 🙂",
    JSON.stringify({ key: "value".repeat(500) }),
  ])("matches node:crypto for input %#", (text) => {
    expect(sha256Hex(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
  });
});

describe("canonicalJson", () => {
  it("sorts object keys at every level and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}',
    );
    expect(canonicalJson([2, 1])).toBe("[2,1]");
    expect(canonicalJson("x")).toBe('"x"');
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson([undefined])).toBe("[null]");
  });

  it("jsonEqual ignores key order and nothing else", () => {
    expect(jsonEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(jsonEqual({ a: 1, b: [1, 2] }, { a: 1, b: [2, 1] })).toBe(false);
    expect(jsonEqual("1", 1)).toBe(false);
    expect(jsonEqual(null, null)).toBe(true);
  });
});

describe("fingerprint", () => {
  it("is 16 hex digits, the same for equal values and different otherwise", () => {
    const a = fingerprint({ x: 1, y: "two" });
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint({ y: "two", x: 1 })).toBe(a);
    expect(fingerprint({ x: 1, y: "Two" })).not.toBe(a);
  });
});
