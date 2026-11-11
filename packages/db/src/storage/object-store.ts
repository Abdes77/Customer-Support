import type { BusinessTenant } from "../context";
import { type AttachmentLocation, assertTenantPath, attachmentPath } from "./paths";

export interface StoredObject {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/**
 * A private bucket. Implementations: Supabase Storage (production), the file system (local
 * development) and memory (tests). This interface knows nothing about tenants: product code
 * never holds one directly, it holds a `TenantStorage`.
 */
export interface ObjectStore {
  readonly bucket: string;
  put(path: string, bytes: Uint8Array, options: { readonly contentType: string }): Promise<void>;
  /** The object, or null when there is none at that path. */
  get(path: string): Promise<StoredObject | null>;
  remove(paths: readonly string[]): Promise<void>;
  /** A URL that serves the object for a short time, to hand to a browser or a provider. */
  signedUrl(path: string, expiresInSeconds: number): Promise<string>;
}

/**
 * The bucket as one business sees it. Every path is checked against the tenant before the
 * store is touched; a path outside the tenant is a `TenantAccessError`.
 *
 * A signed URL is a capability: create one only after checking that the person or system
 * asking may see the file, keep it short-lived, and never store it.
 */
export interface TenantStorage {
  readonly bucket: string;
  /** Stores the bytes of a message attachment and returns where they are. */
  putAttachment(
    location: AttachmentLocation,
    bytes: Uint8Array,
    options: { readonly contentType: string },
  ): Promise<{ readonly bucket: string; readonly path: string }>;
  get(path: string): Promise<StoredObject | null>;
  remove(paths: readonly string[]): Promise<void>;
  /** Default lifetime: five minutes. */
  signedUrl(path: string, expiresInSeconds?: number): Promise<string>;
}

/**
 * The bytes as an ArrayBuffer of exactly their length: the one binary body type that both
 * Node's and the browser's `fetch` and `Response` typings accept.
 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

export const DEFAULT_SIGNED_URL_SECONDS = 5 * 60;
export const MAX_SIGNED_URL_SECONDS = 60 * 60;

export function createTenantStorage(store: ObjectStore, tenant: BusinessTenant): TenantStorage {
  return {
    bucket: store.bucket,

    async putAttachment(location, bytes, options) {
      const path = attachmentPath(tenant, location);
      await store.put(path, bytes, options);
      return { bucket: store.bucket, path };
    },

    async get(path) {
      assertTenantPath(path, tenant);
      return store.get(path);
    },

    async remove(paths) {
      for (const path of paths) assertTenantPath(path, tenant);
      if (paths.length > 0) await store.remove(paths);
    },

    async signedUrl(path, expiresInSeconds = DEFAULT_SIGNED_URL_SECONDS) {
      assertTenantPath(path, tenant);
      const lifetime = Math.min(Math.max(1, Math.floor(expiresInSeconds)), MAX_SIGNED_URL_SECONDS);
      return store.signedUrl(path, lifetime);
    },
  };
}

/** A bucket in memory, for tests. */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, StoredObject>();

  constructor(readonly bucket = "test-attachments") {}

  async put(path: string, bytes: Uint8Array, options: { readonly contentType: string }) {
    this.objects.set(path, { bytes: new Uint8Array(bytes), contentType: options.contentType });
  }

  async get(path: string) {
    return this.objects.get(path) ?? null;
  }

  async remove(paths: readonly string[]) {
    for (const path of paths) this.objects.delete(path);
  }

  async signedUrl(path: string, expiresInSeconds: number) {
    return `memory://${this.bucket}/${path}?expires_in=${expiresInSeconds}`;
  }
}
