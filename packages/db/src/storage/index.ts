import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

import { ConfigError } from "@repo/core";
import {
  type DeploymentInfo,
  deploymentInfo,
  type Env,
  getEnv,
  hasEnv,
  requireEnv,
} from "@repo/core/env";

import type { BusinessTenant } from "../context";
import { createLocalObjectStore, type LocalObjectStore } from "./local-store";
import { createTenantStorage, type ObjectStore, type TenantStorage } from "./object-store";
import { createSupabaseObjectStore } from "./supabase-store";

/**
 * Private file storage for attachments (customer photos and other files), per tenant.
 *
 *   const storage = getTenantStorage(ctx.tenant);
 *   const { bucket, path } = await storage.putAttachment({ conversationId, messageId, fileName }, bytes, { contentType });
 *   const url = await storage.signedUrl(path);   // only after an access check
 *
 * Supabase Storage in production; a folder under `.local/storage` on a developer machine.
 */
export {
  createTenantStorage,
  DEFAULT_SIGNED_URL_SECONDS,
  MAX_SIGNED_URL_SECONDS,
  MemoryObjectStore,
  type ObjectStore,
  type StoredObject,
  type TenantStorage,
} from "./object-store";
export {
  assertTenantPath,
  type AttachmentLocation,
  attachmentPath,
  isObjectPath,
  sanitizeFileName,
  tenantPrefix,
} from "./paths";
export {
  createLocalObjectStore,
  LOCAL_STORAGE_ROUTE,
  type LocalObjectStore,
  serveLocalObject,
} from "./local-store";
export { createSupabaseObjectStore } from "./supabase-store";

/**
 * Where the local store keeps its files: `.local/storage` at the repository root (found by
 * walking up from the working directory, because bundled server code has no file path of
 * its own), or under the working directory when there is no workspace above it.
 */
export function localStorageRoot(startDirectory: string = process.cwd()): string {
  // The comments keep Turbopack from tracing the whole repository into the server bundle
  // because of a path it cannot know in advance; the local store is never used when hosted.
  let directory = path.resolve(/* turbopackIgnore: true */ startDirectory);
  for (;;) {
    if (existsSync(path.join(directory, "pnpm-workspace.yaml"))) break;
    const parent = path.dirname(directory);
    if (parent === directory) {
      directory = path.resolve(/* turbopackIgnore: true */ startDirectory);
      break;
    }
    directory = parent;
  }
  return path.join(directory, ".local", "storage");
}

// Signs local URLs when LOCAL_AUTH_SECRET is not set: links then last until the next restart.
const processSecret = randomBytes(32).toString("base64url");

/** The local store for this environment, or null when the deployment uses Supabase Storage. */
export function createLocalObjectStoreFromEnv(
  env: Env = getEnv(),
  deployment: DeploymentInfo = deploymentInfo(),
): LocalObjectStore | null {
  if (hasEnv(env, "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")) return null;
  if (deployment.environment !== "local") return null;
  return createLocalObjectStore({
    root: localStorageRoot(),
    bucket: env.SUPABASE_STORAGE_BUCKET,
    baseUrl: env.APP_URL ?? "http://localhost:3000",
    secret: env.LOCAL_AUTH_SECRET ?? processSecret,
  });
}

/**
 * The object store this deployment uses: Supabase Storage when the project URL and the
 * service-role key are set, otherwise the local folder on a developer machine. Throws a
 * ConfigError on a hosted deployment without Supabase Storage.
 */
export function createObjectStoreFromEnv(
  env: Env = getEnv(),
  deployment: DeploymentInfo = deploymentInfo(),
): ObjectStore {
  if (hasEnv(env, "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")) {
    const config = requireEnv(env, "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY");
    return createSupabaseObjectStore({
      url: config.NEXT_PUBLIC_SUPABASE_URL,
      serviceRoleKey: config.SUPABASE_SERVICE_ROLE_KEY,
      bucket: env.SUPABASE_STORAGE_BUCKET,
    });
  }
  const local = createLocalObjectStoreFromEnv(env, deployment);
  if (local === null) {
    throw new ConfigError(
      "File storage is not configured: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. See docs/HUMAN_TODO.md.",
      { details: { variables: ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] } },
    );
  }
  return local;
}

let shared: ObjectStore | undefined;

/** Storage confined to one business, on the store this deployment uses. */
export function getTenantStorage(tenant: BusinessTenant): TenantStorage {
  shared ??= createObjectStoreFromEnv();
  return createTenantStorage(shared, tenant);
}
