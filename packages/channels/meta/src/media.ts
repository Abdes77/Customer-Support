import { z } from "zod";

import { ValidationError } from "@repo/core";

import { cleanMimeType, type GraphClient } from "./graph";

/**
 * Inbound media of the Cloud API (and of Messenger attachments fetched by id): look the
 * media id up (`GET /{media-id}` → a URL valid for five minutes), then download the URL with
 * the same token. Media ids from webhooks stay downloadable for seven days.
 */

export const MediaInfo = z.object({
  url: z.string().min(1),
  mime_type: z.string().optional(),
  file_size: z.union([z.number(), z.string()]).optional(),
  sha256: z.string().optional(),
  id: z.string().optional(),
});
export type MediaInfo = z.infer<typeof MediaInfo>;

export interface DownloadedMedia {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

export async function downloadMedia(
  graph: GraphClient,
  options: {
    readonly mediaId: string;
    readonly token: string;
    readonly maxBytes: number;
    /** WhatsApp: the request succeeds only when the media belongs to this number. */
    readonly phoneNumberId?: string;
  },
): Promise<DownloadedMedia> {
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(options.mediaId)) {
    throw new ValidationError("Invalid media id.");
  }
  const info = await graph.request(
    {
      method: "GET",
      path: `/${options.mediaId}`,
      token: options.token,
      ...(options.phoneNumberId === undefined
        ? {}
        : { query: { phone_number_id: options.phoneNumberId } }),
    },
    MediaInfo,
  );
  const declared = Number(info.file_size ?? 0);
  if (Number.isFinite(declared) && declared > options.maxBytes) {
    throw new ValidationError("The file is too large.", { details: { bytes: declared } });
  }
  const file = await graph.download(info.url, options.token, { maxBytes: options.maxBytes });
  // The type Meta recorded for the media is more reliable than the CDN's header.
  const recorded = cleanMimeType(info.mime_type);
  const mimeType = recorded !== "application/octet-stream" ? recorded : file.mimeType;
  return { bytes: file.bytes, mimeType };
}

const UploadResult = z.object({ id: z.string().min(1) });

/** Uploads bytes for sending (`POST /{phone-number-id}/media`) and returns the media id. */
export async function uploadMedia(
  graph: GraphClient,
  options: {
    readonly phoneNumberId: string;
    readonly token: string;
    readonly bytes: Uint8Array;
    readonly mimeType: string;
    readonly fileName: string;
  },
): Promise<string> {
  const form = new FormData();
  form.set("messaging_product", "whatsapp");
  form.set("type", options.mimeType);
  const copy = new Uint8Array(options.bytes.byteLength);
  copy.set(options.bytes);
  form.set("file", new Blob([copy.buffer], { type: options.mimeType }), options.fileName);
  const result = await graph.request(
    { method: "POST", path: `/${options.phoneNumberId}/media`, token: options.token, form },
    UploadResult,
  );
  return result.id;
}

const AttachmentUploadResult = z.object({ attachment_id: z.string().min(1) });

/** Media kinds of the Messenger Platform's Attachment Upload API. */
export type MessageAttachmentType = "image" | "audio" | "video" | "file";

/**
 * Uploads a file for Messenger or Instagram Direct (`POST /{page-id}/message_attachments`,
 * multipart, Attachment Upload API) and returns the attachment id to send it by. Instagram
 * accounts linked to a Page use the same endpoint with `platform: instagram` and the Page's
 * token. File names must be ASCII (Meta refuses others), so the name is cleaned first.
 */
export async function uploadMessageAttachment(
  graph: GraphClient,
  options: {
    readonly pageId: string;
    readonly token: string;
    readonly platform: "messenger" | "instagram";
    readonly type: MessageAttachmentType;
    readonly bytes: Uint8Array;
    readonly mimeType: string;
    readonly fileName: string;
  },
): Promise<string> {
  const form = new FormData();
  if (options.platform === "instagram") form.set("platform", "instagram");
  form.set(
    "message",
    JSON.stringify({ attachment: { type: options.type, payload: { is_reusable: false } } }),
  );
  const copy = new Uint8Array(options.bytes.byteLength);
  copy.set(options.bytes);
  const name = options.fileName.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "file";
  form.set("filedata", new Blob([copy.buffer], { type: options.mimeType }), name);
  const result = await graph.request(
    {
      method: "POST",
      path: `/${options.pageId}/message_attachments`,
      token: options.token,
      form,
    },
    AttachmentUploadResult,
  );
  return result.attachment_id;
}
