import { ExternalServiceError } from "@repo/core";

import { type ObjectStore, type StoredObject, toArrayBuffer } from "./object-store";
import { isObjectPath } from "./paths";

/**
 * Supabase Storage over its REST API, with the service-role key (server only). The bucket
 * is private and has no storage policies, so nothing but this server can read it; browsers
 * get short-lived signed URLs.
 *
 * Built from the Supabase Storage API as documented; not yet run against a live project
 * (docs/HUMAN_TODO.md).
 */
export function createSupabaseObjectStore(options: {
  /** NEXT_PUBLIC_SUPABASE_URL. */
  readonly url: string;
  /** SUPABASE_SERVICE_ROLE_KEY. */
  readonly serviceRoleKey: string;
  readonly bucket: string;
  readonly fetch?: typeof fetch;
}): ObjectStore {
  const doFetch = options.fetch ?? fetch;
  const base = `${options.url.replace(/\/$/, "")}/storage/v1`;
  const auth = {
    apikey: options.serviceRoleKey,
    authorization: `Bearer ${options.serviceRoleKey}`,
  };
  const bucket = encodeURIComponent(options.bucket);

  const objectUrl = (path: string) => {
    if (!isObjectPath(path)) {
      throw new ExternalServiceError("Refusing a malformed storage path.", {
        provider: "supabase_storage",
        retryable: false,
      });
    }
    return `${base}/object/${bucket}/${path.split("/").map(encodeURIComponent).join("/")}`;
  };

  const failure = (action: string, status: number) =>
    new ExternalServiceError(`Supabase Storage could not ${action} the file (HTTP ${status}).`, {
      provider: "supabase_storage",
      status,
    });

  /** Older Storage versions answer "not found" with HTTP 400 and statusCode "404" in the body. */
  async function isNotFound(response: Response): Promise<boolean> {
    if (response.status === 404) return true;
    if (response.status !== 400) return false;
    try {
      const body = (await response.clone().json()) as { statusCode?: unknown; error?: unknown };
      return String(body.statusCode) === "404" || body.error === "not_found";
    } catch {
      return false;
    }
  }

  return {
    bucket: options.bucket,

    async put(path, bytes, { contentType }) {
      const response = await doFetch(objectUrl(path), {
        method: "POST",
        headers: { ...auth, "content-type": contentType, "x-upsert": "true" },
        body: toArrayBuffer(bytes),
      });
      if (!response.ok) throw failure("store", response.status);
    },

    async get(path): Promise<StoredObject | null> {
      const response = await doFetch(objectUrl(path), { method: "GET", headers: auth });
      if (await isNotFound(response)) return null;
      if (!response.ok) throw failure("read", response.status);
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        contentType: response.headers.get("content-type") ?? "application/octet-stream",
      };
    },

    async remove(paths) {
      for (const path of paths) objectUrl(path);
      const response = await doFetch(`${base}/object/${bucket}`, {
        method: "DELETE",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ prefixes: paths }),
      });
      if (!response.ok) throw failure("delete", response.status);
    },

    async signedUrl(path, expiresInSeconds) {
      const target = objectUrl(path).replace(`${base}/object/`, `${base}/object/sign/`);
      const response = await doFetch(target, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ expiresIn: expiresInSeconds }),
      });
      if (!response.ok) throw failure("sign a link to", response.status);
      const body = (await response.json()) as { signedURL?: unknown; signedUrl?: unknown };
      const signed = body.signedURL ?? body.signedUrl;
      if (typeof signed !== "string" || signed === "") {
        throw new ExternalServiceError("Supabase Storage returned no signed link.", {
          provider: "supabase_storage",
          retryable: false,
        });
      }
      // The API answers with a path relative to /storage/v1.
      return signed.startsWith("http")
        ? signed
        : `${base}${signed.startsWith("/") ? "" : "/"}${signed}`;
    },
  };
}
