import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { type AgencyId, type BusinessId, ConfigError, TenantAccessError } from "@repo/core";
import { loadEnv } from "@repo/core/env";

import {
  assertTenantPath,
  attachmentPath,
  createLocalObjectStore,
  createLocalObjectStoreFromEnv,
  createObjectStoreFromEnv,
  createSupabaseObjectStore,
  createTenantStorage,
  isObjectPath,
  type LocalObjectStore,
  localStorageRoot,
  MemoryObjectStore,
  sanitizeFileName,
  serveLocalObject,
  tenantPrefix,
  uploadPath,
} from "./index";

const tenantA = {
  agencyId: "11111111-1111-4111-8111-111111111111" as AgencyId,
  businessId: "22222222-2222-4222-8222-222222222222" as BusinessId,
};
const tenantB = {
  agencyId: "11111111-1111-4111-8111-111111111111" as AgencyId,
  businessId: "33333333-3333-4333-8333-333333333333" as BusinessId,
};
const location = {
  conversationId: "44444444-4444-4444-8444-444444444444",
  messageId: "55555555-5555-4555-8555-555555555555",
  fileName: "roof photo (1).JPG",
};
const bytes = new TextEncoder().encode("not really a jpeg");

describe("paths", () => {
  it("builds {agency}/{business}/{conversation}/{message}/{file}", () => {
    expect(attachmentPath(tenantA, location)).toBe(
      `${tenantA.agencyId}/${tenantA.businessId}/${location.conversationId}/${location.messageId}/roof_photo_1_.JPG`,
    );
    expect(tenantPrefix(tenantA)).toBe(`${tenantA.agencyId}/${tenantA.businessId}/`);
  });

  it("sanitizes file names so they cannot change the path", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("etc_passwd");
    expect(sanitizeFileName(".htaccess")).toBe("htaccess");
    expect(sanitizeFileName("a/b\\c.png")).toBe("a_b_c.png");
    expect(sanitizeFileName("naïve café.png")).toBe("nai_ve_cafe_.png");
    expect(sanitizeFileName("")).toBe("file");
    expect(sanitizeFileName(null)).toBe("file");
    expect(sanitizeFileName("///")).toBe("file");
    expect(sanitizeFileName(`${"x".repeat(300)}.png`)).toHaveLength(100);
    expect(sanitizeFileName(`${"x".repeat(300)}.png`).endsWith(".png")).toBe(true);
  });

  it("refuses ids that are not ids", () => {
    expect(() => attachmentPath(tenantA, { ...location, conversationId: "../other" })).toThrow(
      TenantAccessError,
    );
  });

  it("accepts paths inside the tenant and refuses everything else", () => {
    const own = attachmentPath(tenantA, location);
    expect(() => assertTenantPath(own, tenantA)).not.toThrow();
    for (const bad of [
      attachmentPath(tenantB, location),
      own.replace(tenantA.businessId, tenantB.businessId),
      `${tenantPrefix(tenantA)}../${tenantB.businessId}/x/y/file`,
      `/${own}`,
      `${own}/../../x`,
      own.replace(/\//g, "\\"),
      `${tenantPrefix(tenantA)}`,
      `${tenantA.agencyId}/${tenantA.businessId}x/c/m/file`,
      "",
    ]) {
      expect(() => assertTenantPath(bad, tenantA), bad).toThrow(TenantAccessError);
    }
    expect(isObjectPath("a/b/c")).toBe(true);
    expect(isObjectPath("a//c")).toBe(false);
    expect(isObjectPath("a/./c")).toBe(false);
  });
});

describe("tenant storage", () => {
  it("stores, reads, signs and removes a tenant's own files", async () => {
    const store = new MemoryObjectStore("attachments");
    const storage = createTenantStorage(store, tenantA);
    const saved = await storage.putAttachment(location, bytes, { contentType: "image/jpeg" });
    expect(saved).toEqual({ bucket: "attachments", path: attachmentPath(tenantA, location) });
    expect(await storage.get(saved.path)).toEqual({ bytes, contentType: "image/jpeg" });
    expect(await storage.signedUrl(saved.path)).toContain("expires_in=300");
    expect(await storage.signedUrl(saved.path, 999_999)).toContain("expires_in=3600");
    await storage.remove([saved.path]);
    expect(await storage.get(saved.path)).toBeNull();
  });

  it("stores an upload that has no message yet inside the tenant", async () => {
    const store = new MemoryObjectStore("attachments");
    const storage = createTenantStorage(store, tenantA);
    const upload = {
      ownerId: "0b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a40",
      uploadId: "1c2d3e4f-5061-4b72-9c83-ad9e8f7a6b51",
      fileName: "../../roof photo.jpg",
    };
    const saved = await storage.putUpload(upload, bytes, { contentType: "image/jpeg" });
    expect(saved.path).toBe(
      `${tenantA.agencyId}/${tenantA.businessId}/uploads/${upload.ownerId}/${upload.uploadId}/roof_photo.jpg`,
    );
    expect(saved.path.startsWith(tenantPrefix(tenantA))).toBe(true);
    expect(await storage.get(saved.path)).toEqual({ bytes, contentType: "image/jpeg" });
    expect(() => uploadPath(tenantA, { ...upload, ownerId: "../x" })).toThrow(TenantAccessError);
  });

  it("cannot read, sign or remove another tenant's file", async () => {
    const store = new MemoryObjectStore();
    const theirs = await createTenantStorage(store, tenantB).putAttachment(location, bytes, {
      contentType: "image/jpeg",
    });
    const mine = createTenantStorage(store, tenantA);
    await expect(mine.get(theirs.path)).rejects.toBeInstanceOf(TenantAccessError);
    await expect(mine.signedUrl(theirs.path)).rejects.toBeInstanceOf(TenantAccessError);
    await expect(mine.remove([theirs.path])).rejects.toBeInstanceOf(TenantAccessError);
    expect(store.objects.has(theirs.path)).toBe(true);
  });
});

describe("local object store", () => {
  let root: string;
  let store: LocalObjectStore;
  let clock = new Date("2026-11-11T12:00:00Z");

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hsrb-storage-"));
    store = createLocalObjectStore({
      root,
      bucket: "attachments",
      baseUrl: "http://localhost:3000",
      secret: "local-storage-secret",
      now: () => clock,
    });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips bytes and content type through the file system", async () => {
    const objectPath = attachmentPath(tenantA, location);
    await store.put(objectPath, bytes, { contentType: "image/jpeg" });
    expect(await store.get(objectPath)).toEqual({ bytes, contentType: "image/jpeg" });
    expect(await store.get(attachmentPath(tenantB, location))).toBeNull();
    await store.remove([objectPath]);
    expect(await store.get(objectPath)).toBeNull();
  });

  it("refuses paths that would leave the bucket folder", async () => {
    for (const bad of ["../../etc/passwd", "a/../../b/c", "/etc/passwd", "a/b"]) {
      await expect(store.get(bad), bad).rejects.toBeInstanceOf(TenantAccessError);
      await expect(store.put(bad, bytes, { contentType: "x/y" }), bad).rejects.toBeInstanceOf(
        TenantAccessError,
      );
    }
  });

  it("signs URLs that expire and cannot be moved to another file", async () => {
    clock = new Date("2026-11-11T12:00:00Z");
    const objectPath = attachmentPath(tenantA, location);
    const url = new URL(await store.signedUrl(objectPath, 300));
    expect(url.origin).toBe("http://localhost:3000");
    expect(decodeURIComponent(url.pathname)).toBe(`/api/storage/local/${objectPath}`);
    const expires = url.searchParams.get("expires");
    const signature = url.searchParams.get("signature");

    expect(store.verifySignedUrl(objectPath, expires, signature)).toBe(true);
    // Another file, another expiry, a broken signature, a missing part: all refused.
    expect(store.verifySignedUrl(attachmentPath(tenantB, location), expires, signature)).toBe(
      false,
    );
    expect(store.verifySignedUrl(objectPath, String(Number(expires) + 1), signature)).toBe(false);
    expect(store.verifySignedUrl(objectPath, expires, `${signature}x`)).toBe(false);
    expect(store.verifySignedUrl(objectPath, expires, null)).toBe(false);
    expect(store.verifySignedUrl(objectPath, null, signature)).toBe(false);
    expect(store.verifySignedUrl(objectPath, "1e9", signature)).toBe(false);
    // And after it expired.
    expect(
      store.verifySignedUrl(objectPath, expires, signature, new Date("2026-11-11T12:05:01Z")),
    ).toBe(false);
  });
});

describe("serving signed local URLs", () => {
  let root: string;
  let store: LocalObjectStore;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hsrb-storage-serve-"));
    store = createLocalObjectStore({
      root,
      bucket: "attachments",
      baseUrl: "http://localhost:3000",
      secret: "local-storage-secret",
    });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const queryOf = async (objectPath: string) =>
    new URL(await store.signedUrl(objectPath, 60)).searchParams;

  it("serves an image in place, with headers that stop sniffing and scripts", async () => {
    const objectPath = attachmentPath(tenantA, location);
    await store.put(objectPath, bytes, { contentType: "image/jpeg" });
    const response = await serveLocalObject(store, objectPath, await queryOf(objectPath));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("sends anything a browser could run as a download", async () => {
    for (const contentType of ["text/html", "image/svg+xml", "application/pdf"]) {
      const objectPath = attachmentPath(tenantA, { ...location, fileName: "upload.bin" });
      await store.put(objectPath, bytes, { contentType });
      const response = await serveLocalObject(store, objectPath, await queryOf(objectPath));
      expect(response.headers.get("content-type"), contentType).toBe("application/octet-stream");
      expect(response.headers.get("content-disposition"), contentType).toBe("attachment");
    }
  });

  it("answers 403 without a valid signature and 404 for a signed path with no file", async () => {
    const objectPath = attachmentPath(tenantA, location);
    const other = attachmentPath(tenantB, location);
    await store.put(other, bytes, { contentType: "image/jpeg" });
    expect((await serveLocalObject(store, objectPath, new URLSearchParams())).status).toBe(403);
    // A signature for one file does not open another.
    expect((await serveLocalObject(store, other, await queryOf(objectPath))).status).toBe(403);
    const missing = attachmentPath(tenantA, { ...location, fileName: "missing.jpg" });
    expect((await serveLocalObject(store, missing, await queryOf(missing))).status).toBe(404);
  });
});

describe("Supabase object store", () => {
  const objectPath = attachmentPath(tenantA, location);
  const make = (fetchMock: typeof fetch) =>
    createSupabaseObjectStore({
      url: "https://project.supabase.co/",
      serviceRoleKey: "service-role-key",
      bucket: "attachments",
      fetch: fetchMock,
    });

  it("uploads with the service-role key and upsert", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
    await make(fetchMock).put(objectPath, bytes, { contentType: "image/jpeg" });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`https://project.supabase.co/storage/v1/object/attachments/${objectPath}`);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer service-role-key",
      "content-type": "image/jpeg",
      "x-upsert": "true",
    });
  });

  it("downloads, and reports a missing object as null in both forms the API uses", async () => {
    const found = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(bytes, { status: 200, headers: { "content-type": "image/jpeg" } }),
      );
    expect(await make(found).get(objectPath)).toEqual({ bytes, contentType: "image/jpeg" });

    const missing = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 404 }));
    expect(await make(missing).get(objectPath)).toBeNull();
    const legacyMissing = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ statusCode: "404", error: "not_found" }), { status: 400 }),
      );
    expect(await make(legacyMissing).get(objectPath)).toBeNull();

    const broken = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 500 }));
    await expect(make(broken).get(objectPath)).rejects.toMatchObject({
      retryable: true,
      status: 500,
    });
  });

  it("signs a link and returns it as an absolute URL", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ signedURL: `/object/sign/attachments/${objectPath}?token=abc` }),
        {
          status: 200,
        },
      ),
    );
    expect(await make(fetchMock).signedUrl(objectPath, 120)).toBe(
      `https://project.supabase.co/storage/v1/object/sign/attachments/${objectPath}?token=abc`,
    );
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      `https://project.supabase.co/storage/v1/object/sign/attachments/${objectPath}`,
    );
    expect(JSON.parse(init?.body as string)).toEqual({ expiresIn: 120 });
  });

  it("deletes by path, and never sends a malformed path", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("[]", { status: 200 }));
    await make(fetchMock).remove([objectPath]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://project.supabase.co/storage/v1/object/attachments");
    expect(init?.method).toBe("DELETE");
    expect(JSON.parse(init?.body as string)).toEqual({ prefixes: [objectPath] });

    fetchMock.mockClear();
    await expect(make(fetchMock).get("../other-bucket/x/y")).rejects.toThrow(/malformed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not put the key in an error", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 403 }));
    const error = await make(fetchMock)
      .put(objectPath, bytes, { contentType: "image/jpeg" })
      .catch((caught: unknown) => caught);
    expect(JSON.stringify(error) + String(error)).not.toContain("service-role-key");
  });
});

describe("store selection", () => {
  const local = { environment: "local", commitSha: null, region: null } as const;
  const hosted = { environment: "production", commitSha: "abc", region: "iad1" } as const;

  it("uses Supabase Storage when the project and service-role key are configured", () => {
    const env = loadEnv({
      NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      SUPABASE_STORAGE_BUCKET: "photos",
    });
    expect(createObjectStoreFromEnv(env, hosted).bucket).toBe("photos");
    expect(createLocalObjectStoreFromEnv(env, local)).toBeNull();
  });

  it("keeps local files in .local/storage at the repository root, wherever it is called from", () => {
    const fromPackage = localStorageRoot(import.meta.dirname);
    const fromApp = localStorageRoot(path.resolve(import.meta.dirname, "../../../../apps/web"));
    expect(fromPackage).toBe(fromApp);
    expect(fromPackage.endsWith(path.join(".local", "storage"))).toBe(true);
    expect(localStorageRoot(os.tmpdir())).toBe(path.join(os.tmpdir(), ".local", "storage"));
  });

  it("uses the local folder on a developer machine, and nothing on a hosted one", () => {
    const env = loadEnv({});
    expect(createObjectStoreFromEnv(env, local).bucket).toBe("attachments");
    expect(createLocalObjectStoreFromEnv(env, local)).not.toBeNull();
    expect(createLocalObjectStoreFromEnv(env, hosted)).toBeNull();
    expect(() => createObjectStoreFromEnv(env, hosted)).toThrow(ConfigError);
  });
});
