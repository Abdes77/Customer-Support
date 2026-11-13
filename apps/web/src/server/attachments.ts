import type { AgencyId, BusinessId } from "@repo/core";
import { findVisibleAttachment } from "@repo/db";
import { isObjectPath, type TenantStorage } from "@repo/db/storage";

import { type SessionAccess, userDatabase } from "@/server/auth";
import { businessPermissions } from "@/server/portal";

/*
 * Serves a customer's file from a conversation (C16) to a signed-in person who may read that
 * conversation, and to nobody else. The file is looked up as the person (row-level security),
 * the business's client-portal settings are applied, and the bytes are read from the
 * tenant's own storage. Only common photo types are shown inline; everything else downloads
 * as `application/octet-stream` with its name cleaned, so a customer's HTML or SVG never runs
 * on our origin.
 */

const INLINE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/heic"]);

/** A file name safe for `Content-Disposition`: ASCII fallback plus the RFC 5987 form. */
export function contentDisposition(kind: "inline" | "attachment", name: string | null): string {
  // eslint-disable-next-line no-control-regex -- control characters are what is replaced
  const raw = (name ?? "file").replace(/[\u0000-\u001f\u007f/\\]/g, "_").slice(0, 120) || "file";
  const ascii = raw.replace(/[^\x20-\x7e]/g, "_").replace(/["%;]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(raw)}`;
}

export interface AttachmentRouteDeps {
  readonly getAccess: () => Promise<SessionAccess | null>;
  readonly storage: (tenant: { agencyId: AgencyId; businessId: BusinessId }) => TenantStorage;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

const notFound = () =>
  new Response("Not found", {
    status: 404,
    headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
  });

export async function serveAttachment(
  deps: AttachmentRouteDeps,
  attachmentId: string,
): Promise<Response> {
  const session = await deps.getAccess();
  if (session === null) return notFound();
  const found = await userDatabase(session.user).run((ctx) =>
    findVisibleAttachment(ctx, attachmentId),
  );
  if (found === null) return notFound();
  const tenant = { agencyId: found.agencyId as AgencyId, businessId: found.businessId };
  const permissions = await businessPermissions(session, tenant);
  if (!permissions.viewConversations) return notFound();
  // The stored path must be in this tenant's folder (the storage refuses others as well).
  if (
    !isObjectPath(found.storagePath) ||
    !found.storagePath.startsWith(`${tenant.agencyId}/${tenant.businessId}/`)
  ) {
    return notFound();
  }
  const object = await deps.storage(tenant).get(found.storagePath);
  if (object === null) return notFound();
  const declared = (found.mimeType ?? object.contentType ?? "").toLowerCase().split(";")[0]!.trim();
  const inline = INLINE_TYPES.has(declared);
  return new Response(toArrayBuffer(object.bytes), {
    status: 200,
    headers: {
      "content-type": inline ? declared : "application/octet-stream",
      "content-disposition": contentDisposition(inline ? "inline" : "attachment", found.fileName),
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, no-store",
      "cross-origin-resource-policy": "same-origin",
    },
  });
}
