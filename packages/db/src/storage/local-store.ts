import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { TenantAccessError } from "@repo/core";

import { type ObjectStore, type StoredObject, toArrayBuffer } from "./object-store";
import { isObjectPath } from "./paths";

/** Path of the app route that serves files of the local store. */
export const LOCAL_STORAGE_ROUTE = "/api/storage/local";

export interface LocalObjectStore extends ObjectStore {
  /**
   * Checks the query of a signed URL made by `signedUrl`. True when the signature matches
   * the path and the link has not expired.
   */
  verifySignedUrl(
    objectPath: string,
    expires: string | null,
    signature: string | null,
    now?: Date,
  ): boolean;
}

/**
 * The bucket as a folder on disk, for local development and CI where there is no Supabase
 * Storage. Signed URLs point at an app route (`/api/storage/local/...`) and carry an expiry
 * and an HMAC, so they behave like the real thing: short-lived, unguessable, per file.
 */
export function createLocalObjectStore(options: {
  /** Folder that holds the files. */
  readonly root: string;
  readonly bucket: string;
  /** Origin the signed URLs point at (APP_URL). */
  readonly baseUrl: string;
  /** Signs the URLs. */
  readonly secret: string;
  readonly now?: () => Date;
}): LocalObjectStore {
  const root = path.resolve(options.root, options.bucket);
  const now = options.now ?? (() => new Date());

  function fileOf(objectPath: string): string {
    if (!isObjectPath(objectPath)) {
      throw new TenantAccessError("Refusing a malformed storage path.");
    }
    const file = path.resolve(root, ...objectPath.split("/"));
    // Belt and braces: the resolved file must still be inside the bucket folder.
    if (!file.startsWith(`${root}${path.sep}`)) {
      throw new TenantAccessError("Refusing a storage path outside the bucket.");
    }
    return file;
  }

  // The secret is LOCAL_AUTH_SECRET, which also signs local sessions: the prefix keeps a
  // storage signature from ever being valid as anything else.
  const sign = (objectPath: string, expires: number) =>
    createHmac("sha256", options.secret)
      .update(`hsrb-local-storage-url\n${options.bucket}/${objectPath}:${expires}`)
      .digest();

  return {
    bucket: options.bucket,

    async put(objectPath, bytes, { contentType }) {
      const file = fileOf(objectPath);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
      await writeFile(`${file}.content-type`, contentType, "utf8");
    },

    async get(objectPath): Promise<StoredObject | null> {
      const file = fileOf(objectPath);
      try {
        const [bytes, contentType] = await Promise.all([
          readFile(file),
          readFile(`${file}.content-type`, "utf8").catch(() => "application/octet-stream"),
        ]);
        return { bytes: new Uint8Array(bytes), contentType };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },

    async remove(paths) {
      for (const objectPath of paths) {
        const file = fileOf(objectPath);
        await rm(file, { force: true });
        await rm(`${file}.content-type`, { force: true });
      }
    },

    async signedUrl(objectPath, expiresInSeconds) {
      fileOf(objectPath);
      const expires = Math.floor(now().getTime() / 1000) + expiresInSeconds;
      const url = new URL(
        `${LOCAL_STORAGE_ROUTE}/${objectPath.split("/").map(encodeURIComponent).join("/")}`,
        options.baseUrl,
      );
      url.searchParams.set("expires", String(expires));
      url.searchParams.set("signature", sign(objectPath, expires).toString("base64url"));
      return url.toString();
    },

    verifySignedUrl(objectPath, expires, signature, at = now()) {
      if (expires === null || signature === null || !/^\d{1,12}$/.test(expires)) return false;
      if (!isObjectPath(objectPath)) return false;
      const expiry = Number(expires);
      if (expiry <= Math.floor(at.getTime() / 1000)) return false;
      const expected = sign(objectPath, expiry);
      const actual = Buffer.from(signature, "base64url");
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    },
  };
}

/** Types a browser may show in place. Everything else is sent as a download. */
const INLINE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/**
 * Answers a request for a signed local URL: the file when the signature is valid and not
 * expired, otherwise 403 or 404. The headers stop the browser from guessing a type or
 * running anything a customer uploaded.
 */
export async function serveLocalObject(
  store: LocalObjectStore,
  objectPath: string,
  query: URLSearchParams,
): Promise<Response> {
  if (!store.verifySignedUrl(objectPath, query.get("expires"), query.get("signature"))) {
    return new Response("Forbidden", { status: 403 });
  }
  const object = await store.get(objectPath);
  if (object === null) return new Response("Not found", { status: 404 });
  const contentType = object.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const inline = INLINE_TYPES.has(contentType);
  return new Response(toArrayBuffer(object.bytes), {
    status: 200,
    headers: {
      "content-type": inline ? contentType : "application/octet-stream",
      "content-disposition": inline ? "inline" : "attachment",
      "content-length": String(object.bytes.byteLength),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}
