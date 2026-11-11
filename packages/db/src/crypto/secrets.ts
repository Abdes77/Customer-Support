import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { z } from "zod";

import { AppError, ConfigError } from "@repo/core";
import { type Env, getEnv, requireEnv } from "@repo/core/env";

/**
 * Application-layer encryption for tenant secrets (OAuth tokens, page tokens, SMTP and IMAP
 * passwords, CRM keys, webhook signing secrets).
 *
 * - AES-256-GCM with a random 96-bit nonce per encryption.
 * - The key comes from CREDENTIALS_ENCRYPTION_KEY. Every envelope records the id of the key
 *   that made it, so a key can be rotated: new writes use the primary key, old envelopes
 *   keep decrypting with the retired keys in CREDENTIALS_ENCRYPTION_OLD_KEYS.
 * - The owner of the secret (agency, business, purpose, record id) is bound in as additional
 *   authenticated data. An envelope copied onto another tenant's row, or onto another row of
 *   the same tenant, does not decrypt.
 *
 * Envelope: `v1.<keyId>.<nonce>.<ciphertext>.<tag>`, the last three base64url-encoded.
 *
 * Decrypt just in time, inside the step that makes the vendor call. Never log a decrypted
 * value, never return one from a server action or API, never put one in a job payload.
 */

const VERSION = "v1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const KEY_ID_PATTERN = /^[a-z0-9_-]{1,16}$/;

export interface Keyring {
  /** Id of the key that encrypts new values. */
  readonly primaryKeyId: string;
  /** Every key that can decrypt, by id (the primary key included). */
  readonly keys: ReadonlyMap<string, Buffer>;
}

export interface KeyInput {
  readonly id: string;
  /** 32 bytes, base64-encoded (`openssl rand -base64 32`). */
  readonly key: string;
}

/** What a secret belongs to. All four parts are authenticated; none is secret. */
export interface SecretBinding {
  readonly agencyId: string;
  /** Null for an agency-level secret. */
  readonly businessId: string | null;
  /** What kind of secret it is, for example "channel_connection". */
  readonly purpose: string;
  /** Id of the row the secret belongs to. */
  readonly recordId: string;
}

/** A stored secret could not be decrypted. The message never contains key or plaintext. */
export class SecretDecryptionError extends AppError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super("internal", message, { cause: options.cause, retryable: false });
  }
}

function decodeKey(input: KeyInput): Buffer {
  if (!KEY_ID_PATTERN.test(input.id)) {
    throw new ConfigError(
      "Encryption key ids must be 1 to 16 characters of a-z, 0-9, underscore or hyphen.",
    );
  }
  const key = /^[A-Za-z0-9+/]+={0,2}$/.test(input.key)
    ? Buffer.from(input.key, "base64")
    : Buffer.alloc(0);
  if (key.length !== KEY_BYTES) {
    throw new ConfigError(
      `Encryption key "${input.id}" must be 32 bytes, base64-encoded (openssl rand -base64 32).`,
    );
  }
  return key;
}

export function createKeyring(primary: KeyInput, retired: readonly KeyInput[] = []): Keyring {
  const keys = new Map<string, Buffer>();
  keys.set(primary.id, decodeKey(primary));
  for (const input of retired) {
    if (keys.has(input.id)) {
      throw new ConfigError(`Encryption key id "${input.id}" is used twice.`);
    }
    keys.set(input.id, decodeKey(input));
  }
  return { primaryKeyId: primary.id, keys };
}

/** Parses `id:base64key,id:base64key` (CREDENTIALS_ENCRYPTION_OLD_KEYS). */
export function parseRetiredKeys(value: string | undefined): KeyInput[] {
  if (value === undefined || value.trim() === "") return [];
  return value.split(",").map((pair) => {
    const separator = pair.indexOf(":");
    if (separator <= 0) {
      throw new ConfigError(
        "CREDENTIALS_ENCRYPTION_OLD_KEYS must be id:base64key pairs separated by commas.",
      );
    }
    return { id: pair.slice(0, separator).trim(), key: pair.slice(separator + 1).trim() };
  });
}

/** The key ring configured in the environment. Throws a ConfigError when the key is missing. */
export function keyringFromEnv(env: Env = getEnv()): Keyring {
  const { CREDENTIALS_ENCRYPTION_KEY } = requireEnv(env, "CREDENTIALS_ENCRYPTION_KEY");
  return createKeyring(
    { id: env.CREDENTIALS_ENCRYPTION_KEY_ID, key: CREDENTIALS_ENCRYPTION_KEY },
    parseRetiredKeys(env.CREDENTIALS_ENCRYPTION_OLD_KEYS),
  );
}

function additionalData(binding: SecretBinding): Buffer {
  // A JSON array keeps the parts unambiguous whatever characters they contain.
  return Buffer.from(
    JSON.stringify([
      "hsrb-secret",
      VERSION,
      binding.agencyId,
      binding.businessId,
      binding.purpose,
      binding.recordId,
    ]),
    "utf8",
  );
}

/** Encrypts `plaintext` for the row described by `binding` with the primary key. */
export function encryptSecret(plaintext: string, binding: SecretBinding, keyring: Keyring): string {
  const key = keyring.keys.get(keyring.primaryKeyId);
  if (key === undefined) {
    throw new ConfigError("The key ring has no primary key.");
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(additionalData(binding));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    VERSION,
    keyring.primaryKeyId,
    nonce.toString("base64url"),
    ciphertext.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}

interface ParsedEnvelope {
  readonly keyId: string;
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly tag: Buffer;
}

function parseEnvelope(envelope: string): ParsedEnvelope {
  const parts = envelope.split(".");
  const [version, keyId, nonce, ciphertext, tag] = parts;
  if (
    parts.length !== 5 ||
    version !== VERSION ||
    keyId === undefined ||
    nonce === undefined ||
    ciphertext === undefined ||
    tag === undefined ||
    !KEY_ID_PATTERN.test(keyId)
  ) {
    throw new SecretDecryptionError("The stored secret is not a valid envelope.");
  }
  const parsed = {
    keyId,
    nonce: Buffer.from(nonce, "base64url"),
    ciphertext: Buffer.from(ciphertext, "base64url"),
    tag: Buffer.from(tag, "base64url"),
  };
  if (parsed.nonce.length !== NONCE_BYTES || parsed.tag.length !== TAG_BYTES) {
    throw new SecretDecryptionError("The stored secret is not a valid envelope.");
  }
  return parsed;
}

/** Id of the key that encrypted an envelope. */
export function secretKeyId(envelope: string): string {
  return parseEnvelope(envelope).keyId;
}

/** True when the envelope was made with a retired key and should be encrypted again. */
export function needsReencryption(envelope: string, keyring: Keyring): boolean {
  return secretKeyId(envelope) !== keyring.primaryKeyId;
}

/**
 * Decrypts an envelope. Fails with `SecretDecryptionError` when the envelope was tampered
 * with or belongs to another row (the binding does not match), and with `ConfigError` when
 * the key that made it is not in the key ring.
 */
export function decryptSecret(envelope: string, binding: SecretBinding, keyring: Keyring): string {
  const parsed = parseEnvelope(envelope);
  const key = keyring.keys.get(parsed.keyId);
  if (key === undefined) {
    throw new ConfigError(
      `A stored secret was encrypted with key "${parsed.keyId}", which is not configured. ` +
        "Add it to CREDENTIALS_ENCRYPTION_OLD_KEYS.",
    );
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, parsed.nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(additionalData(binding));
    decipher.setAuthTag(parsed.tag);
    return Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]).toString("utf8");
  } catch (cause) {
    throw new SecretDecryptionError(
      "The stored secret could not be decrypted: it was changed or belongs to another record.",
      { cause },
    );
  }
}

/** Encrypts a JSON-serializable value (the usual shape: an object of tokens). */
export function encryptJson(value: unknown, binding: SecretBinding, keyring: Keyring): string {
  return encryptSecret(JSON.stringify(value), binding, keyring);
}

/** Decrypts an envelope made by `encryptJson` and validates it when a schema is given. */
export function decryptJson<T = unknown>(
  envelope: string,
  binding: SecretBinding,
  keyring: Keyring,
  schema?: z.ZodType<T>,
): T {
  const text = decryptSecret(envelope, binding, keyring);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new SecretDecryptionError("The stored secret is not valid JSON.", { cause });
  }
  if (schema === undefined) return value as T;
  const result = schema.safeParse(value);
  if (!result.success) {
    // Zod issues can quote the offending value; keep them out of the message.
    throw new SecretDecryptionError("The stored secret does not have the expected shape.");
  }
  return result.data;
}

/**
 * A display hint for a secret, safe to show in the admin panel: the last four characters of
 * a long value, nothing of a short one.
 */
export function maskSecret(value: string): string {
  return value.length >= 12 ? `••••${value.slice(-4)}` : "••••";
}
