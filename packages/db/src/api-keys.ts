import { createHash, randomBytes } from "node:crypto";

/**
 * API keys for the import API (C6). A key looks like `hsrb_<8 hex>_<43 characters>`:
 * the prefix identifies the key in the admin panel, the rest is 256 bits of randomness.
 * Only the SHA-256 hash is stored (a fast hash is enough for a random key of this length),
 * so a key can be shown exactly once, when it is created.
 */

const KEY_PATTERN = /^hsrb_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/;

export interface GeneratedApiKey {
  /** The key itself. Show it once; it cannot be recovered. */
  readonly key: string;
  /** `hsrb_<8 hex>`: stored in `api_keys.key_prefix`. */
  readonly prefix: string;
  /** Stored in `api_keys.key_hash`. */
  readonly hash: string;
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function generateApiKey(): GeneratedApiKey {
  const prefix = `hsrb_${randomBytes(4).toString("hex")}`;
  const key = `${prefix}_${randomBytes(32).toString("base64url")}`;
  return { key, prefix, hash: hashApiKey(key) };
}

/** Cheap shape check before hashing, so garbage never reaches the database. */
export function looksLikeApiKey(value: string): boolean {
  return KEY_PATTERN.test(value);
}
