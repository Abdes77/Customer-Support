import { TenantAccessError } from "@repo/core";

import type { BusinessTenant } from "../context";

/*
 * Object paths in the private bucket (ARCHITECTURE §3):
 *
 *   {agencyId}/{businessId}/{conversationId}/{messageId}/{file}
 *
 * The first two segments are the tenant. Every read, write and signed URL goes through
 * `assertTenantPath`, so a path taken from a database row, a job payload or a request can
 * never reach another tenant's files, whatever it contains.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEGMENT = /^[A-Za-z0-9._-]{1,200}$/;

export interface AttachmentLocation {
  readonly conversationId: string;
  readonly messageId: string;
  /** The name the customer's file had, if any. It is sanitized, never trusted. */
  readonly fileName: string | null | undefined;
}

/**
 * A file name that is safe as one path segment: letters, digits, dot, underscore and hyphen;
 * no leading dot; at most 100 characters. Anything else becomes an underscore.
 */
export function sanitizeFileName(name: string | null | undefined, fallback = "file"): string {
  const base = (name ?? "").normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "_");
  const trimmed = base.replace(/^[._]+/, "").slice(-100);
  return trimmed === "" ? fallback : trimmed;
}

/** `{agencyId}/{businessId}/`: the prefix every object of the business lives under. */
export function tenantPrefix(tenant: BusinessTenant): string {
  return `${tenant.agencyId}/${tenant.businessId}/`;
}

/** The path of an attachment of one message. */
export function attachmentPath(tenant: BusinessTenant, location: AttachmentLocation): string {
  if (!UUID.test(location.conversationId) || !UUID.test(location.messageId)) {
    throw new TenantAccessError("An attachment path needs a conversation id and a message id.");
  }
  return `${tenantPrefix(tenant)}${location.conversationId}/${location.messageId}/${sanitizeFileName(location.fileName)}`;
}

/** True when `path` is a well-formed object path (no traversal, no empty segments). */
export function isObjectPath(path: string): boolean {
  const segments = path.split("/");
  return (
    segments.length >= 3 &&
    segments.every((segment) => SEGMENT.test(segment) && segment !== "." && segment !== "..")
  );
}

/** Throws `TenantAccessError` unless `path` is a well-formed path inside the tenant. */
export function assertTenantPath(path: string, tenant: BusinessTenant): void {
  if (!isObjectPath(path) || !path.startsWith(tenantPrefix(tenant))) {
    throw new TenantAccessError("The file does not belong to this business.", {
      details: { businessId: tenant.businessId },
    });
  }
}
