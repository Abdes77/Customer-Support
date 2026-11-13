import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ConfigError } from "@repo/core";
import { loadEnv } from "@repo/core/env";

import {
  createKeyring,
  decryptJson,
  decryptSecret,
  encryptJson,
  encryptSecret,
  keyringFromEnv,
  maskSecret,
  needsReencryption,
  parseRetiredKeys,
  type SecretBinding,
  SecretDecryptionError,
  secretKeyId,
} from "./secrets";

const key = () => randomBytes(32).toString("base64");

const binding: SecretBinding = {
  agencyId: "11111111-1111-4111-8111-111111111111",
  businessId: "22222222-2222-4222-8222-222222222222",
  purpose: "channel_connection",
  recordId: "33333333-3333-4333-8333-333333333333",
};

describe("encryptSecret / decryptSecret", () => {
  const keyring = createKeyring({ id: "k1", key: key() });

  it("round-trips text, including unicode and the empty string", () => {
    for (const plaintext of ["EAAG-page-token", "pässwörd ✓ 密码", ""]) {
      const envelope = encryptSecret(plaintext, binding, keyring);
      expect(decryptSecret(envelope, binding, keyring)).toBe(plaintext);
    }
  });

  it("produces an envelope that names the key and does not contain the plaintext", () => {
    const envelope = encryptSecret("super-secret-token-value", binding, keyring);
    expect(envelope).toMatch(/^v1\.k1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(envelope).not.toContain("super-secret-token-value");
    expect(Buffer.from(envelope.split(".")[3] ?? "", "base64url").toString()).not.toContain(
      "super-secret",
    );
    expect(secretKeyId(envelope)).toBe("k1");
  });

  it("uses a fresh nonce every time", () => {
    const envelopes = new Set(
      Array.from({ length: 50 }, () => encryptSecret("same", binding, keyring)),
    );
    expect(envelopes.size).toBe(50);
  });

  it.each([
    ["another agency", { agencyId: "99999999-9999-4999-8999-999999999999" }],
    ["another business", { businessId: "99999999-9999-4999-8999-999999999999" }],
    ["an agency-level row", { businessId: null }],
    ["another purpose", { purpose: "integration_connection" }],
    ["another record", { recordId: "99999999-9999-4999-8999-999999999999" }],
  ])("does not decrypt for %s", (_label, change) => {
    const envelope = encryptSecret("token", binding, keyring);
    expect(() => decryptSecret(envelope, { ...binding, ...change }, keyring)).toThrow(
      SecretDecryptionError,
    );
  });

  it("detects a changed nonce, ciphertext or tag", () => {
    const envelope = encryptSecret("token-token-token", binding, keyring);
    const parts = envelope.split(".");
    for (const index of [2, 3, 4]) {
      const bytes = Buffer.from(parts[index] ?? "", "base64url");
      bytes[0] = (bytes[0] ?? 0) ^ 0x01;
      const tampered = parts.map((part, i) => (i === index ? bytes.toString("base64url") : part));
      expect(() => decryptSecret(tampered.join("."), binding, keyring), `part ${index}`).toThrow(
        SecretDecryptionError,
      );
    }
  });

  it("rejects anything that is not an envelope", () => {
    for (const bad of [
      "",
      "plaintext",
      "v2.k1.a.b.c",
      "v1.k1.a.b",
      "v1.BAD KEY.a.b.c",
      "v1.k1.AA.AA.AA",
    ]) {
      expect(() => decryptSecret(bad, binding, keyring), bad).toThrow(SecretDecryptionError);
    }
  });

  it("never puts the plaintext or the key in an error", () => {
    const secretKey = key();
    const ring = createKeyring({ id: "k1", key: secretKey });
    const envelope = encryptSecret("the-plaintext", binding, ring);
    try {
      decryptSecret(envelope, { ...binding, recordId: "other" }, ring);
      expect.unreachable();
    } catch (error) {
      const text = `${(error as Error).message} ${JSON.stringify(error)}`;
      expect(text).not.toContain("the-plaintext");
      expect(text).not.toContain(secretKey);
    }
  });
});

describe("key rotation", () => {
  const oldKey = { id: "k1", key: key() };
  const newKey = { id: "k2", key: key() };

  it("decrypts old envelopes with a retired key and encrypts new ones with the primary", () => {
    const before = createKeyring(oldKey);
    const after = createKeyring(newKey, [oldKey]);
    const old = encryptSecret("token", binding, before);

    expect(decryptSecret(old, binding, after)).toBe("token");
    expect(needsReencryption(old, after)).toBe(true);

    const fresh = encryptSecret("token", binding, after);
    expect(secretKeyId(fresh)).toBe("k2");
    expect(needsReencryption(fresh, after)).toBe(false);
  });

  it("fails with a configuration error when the key of an envelope is gone", () => {
    const old = encryptSecret("token", binding, createKeyring(oldKey));
    expect(() => decryptSecret(old, binding, createKeyring(newKey))).toThrow(ConfigError);
  });

  it("does not decrypt with a different key that carries the same id", () => {
    const old = encryptSecret("token", binding, createKeyring(oldKey));
    const impostor = createKeyring({ id: "k1", key: key() });
    expect(() => decryptSecret(old, binding, impostor)).toThrow(SecretDecryptionError);
  });
});

describe("key ring", () => {
  it("rejects keys that are not 32 bytes of base64", () => {
    for (const bad of ["", "short", randomBytes(16).toString("base64"), "not base64 !!"]) {
      expect(() => createKeyring({ id: "k1", key: bad }), bad).toThrow(ConfigError);
    }
  });

  it("rejects bad or duplicate key ids", () => {
    expect(() => createKeyring({ id: "Has Space", key: key() })).toThrow(ConfigError);
    expect(() => createKeyring({ id: "k1", key: key() }, [{ id: "k1", key: key() }])).toThrow(
      ConfigError,
    );
  });

  it("parses CREDENTIALS_ENCRYPTION_OLD_KEYS", () => {
    const a = key();
    const b = key();
    expect(parseRetiredKeys(undefined)).toEqual([]);
    expect(parseRetiredKeys(`k1:${a}, k2:${b}`)).toEqual([
      { id: "k1", key: a },
      { id: "k2", key: b },
    ]);
    expect(() => parseRetiredKeys("no-separator")).toThrow(ConfigError);
  });

  it("builds the ring from the environment", () => {
    const primary = key();
    const retired = key();
    const ring = keyringFromEnv(
      loadEnv({
        CREDENTIALS_ENCRYPTION_KEY: primary,
        CREDENTIALS_ENCRYPTION_KEY_ID: "k7",
        CREDENTIALS_ENCRYPTION_OLD_KEYS: `k6:${retired}`,
      }),
    );
    expect(ring.primaryKeyId).toBe("k7");
    expect([...ring.keys.keys()].sort()).toEqual(["k6", "k7"]);
  });

  it("says which variable is missing when there is no key", () => {
    expect(() => keyringFromEnv(loadEnv({}))).toThrow(/CREDENTIALS_ENCRYPTION_KEY/);
  });
});

describe("JSON secrets", () => {
  const keyring = createKeyring({ id: "k1", key: key() });
  const Credentials = z.object({ accessToken: z.string(), refreshToken: z.string().nullable() });

  it("round-trips an object and validates it", () => {
    const value = { accessToken: "at", refreshToken: null };
    const envelope = encryptJson(value, binding, keyring);
    expect(decryptJson(envelope, binding, keyring, Credentials)).toEqual(value);
    expect(decryptJson(envelope, binding, keyring)).toEqual(value);
  });

  it("fails without quoting the value when the shape is wrong", () => {
    const envelope = encryptJson({ accessToken: 12345678 }, binding, keyring);
    try {
      decryptJson(envelope, binding, keyring, Credentials);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SecretDecryptionError);
      expect((error as Error).message).not.toContain("12345678");
    }
  });
});

describe("maskSecret", () => {
  it("shows the last four characters of a long value only", () => {
    expect(maskSecret("EAAGm0PX4ZCpsBAKZCx")).toBe("••••KZCx");
    expect(maskSecret("short")).toBe("••••");
  });
});
