import {
  type AgencyId,
  AppError,
  BusinessId,
  type Logger,
  newTraceId,
  type TraceId,
} from "@repo/core";
import {
  and,
  type ApiKeyRef,
  businesses,
  type Database,
  eq,
  importRuns,
  type SystemContext,
} from "@repo/db";

import type { ImportMode, ImportResult, ProfileMode } from "./apply";
import { CSV_LIMITS } from "./csv";
import { ColumnMapping } from "./mapping";
import { importApiRecords, importCsv } from "./run";

/**
 * The import API: functions from `Request` to `Response` that the routes under
 * `apps/web/src/app/api/v1` call. Keeping them here keeps the routes thin and lets the
 * whole request path be tested against a database without a web server.
 *
 *   POST /api/v1/knowledge/import          JSON records
 *   POST /api/v1/knowledge/import/csv      a CSV file (text/csv, or multipart/form-data)
 *   GET  /api/v1/knowledge/imports/{id}    the state of one import run
 *
 * Authentication is a bearer API key (`hsrb_...`, created by an agency admin). The key
 * decides the tenant: an agency key may write any business of its agency, a key bound to one
 * business only that business. Nothing in the request can widen that.
 */

export const IMPORT_SCOPE_WRITE = "knowledge:write";
export const IMPORT_SCOPE_READ = "knowledge:read";

/** JSON bodies above this size are refused. */
export const MAX_JSON_BYTES = 2 * 1024 * 1024;

export interface ImportApiDeps {
  readonly db: Database;
  readonly logger: Logger;
  readonly clock?: () => Date;
}

interface Caller {
  readonly key: ApiKeyRef;
  readonly traceId: TraceId;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function failure(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return json(status, { error: { code, message, ...extra } }, headers);
}

/** The caller behind the request's API key, or the response that refuses it. */
async function authenticate(
  request: Request,
  deps: ImportApiDeps,
  scope: string,
): Promise<Caller | Response> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  const challenge = { "www-authenticate": 'Bearer realm="import"' };
  if (match?.[1] === undefined) {
    return failure(
      401,
      "unauthorized",
      "Send the API key as: Authorization: Bearer <key>",
      {},
      challenge,
    );
  }
  const now = (deps.clock ?? (() => new Date()))();
  const key = await deps.db.directory.authenticateApiKey(match[1], now);
  if (key === null) {
    // One answer for unknown, revoked and expired keys.
    return failure(401, "unauthorized", "The API key is not valid.", {}, challenge);
  }
  const allowed =
    key.scopes.includes(scope) ||
    (scope === IMPORT_SCOPE_READ && key.scopes.includes(IMPORT_SCOPE_WRITE));
  if (!allowed) {
    return failure(403, "forbidden", `The API key does not have the scope "${scope}".`);
  }
  return { key, traceId: newTraceId() };
}

/** Reads the body as text, refusing one that is larger than `maxBytes`. */
async function readBody(request: Request, maxBytes: number): Promise<string | Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  const tooLarge = () =>
    failure(413, "too_large", `The request body is too large: at most ${maxBytes} bytes.`);
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge();
  if (request.body === null) return "";
  // Read in pieces, so that a body without (or with a wrong) length still cannot grow past
  // the limit in memory. Leaving the loop cancels the stream.
  const stream = request.body as unknown as AsyncIterable<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > maxBytes) return tooLarge();
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(bytes);
}

function resultBody(result: ImportResult): Record<string, unknown> {
  return {
    importRunId: result.importRunId,
    status: result.status,
    stats: result.stats,
    problems: result.problems,
  };
}

/** 200 when something was imported, 422 when nothing could be. The body is the same. */
function resultResponse(result: ImportResult, extra: Record<string, unknown> = {}): Response {
  return json(result.status === "failed" ? 422 : 200, { ...resultBody(result), ...extra });
}

function errorResponse(error: unknown, deps: ImportApiDeps, caller: Caller): Response {
  if (error instanceof AppError && error.code === "not_found") {
    return failure(404, "not_found", error.message);
  }
  if (error instanceof AppError && error.code === "tenant_access_denied") {
    return failure(403, "forbidden", "The API key cannot write this business.");
  }
  if (error instanceof AppError && error.code === "validation_failed") {
    return failure(400, "invalid_request", error.message);
  }
  deps.logger.error("import_api.failed", {
    traceId: caller.traceId,
    agencyId: caller.key.agencyId,
    apiKeyId: caller.key.id,
    error,
  });
  return failure(500, "internal", "The import could not be completed.", {
    traceId: caller.traceId,
  });
}

/** One transaction in the scope the key allows: its business, or its whole agency. */
function runScoped<T>(
  deps: ImportApiDeps,
  key: ApiKeyRef,
  businessId: BusinessId | null,
  fn: (ctx: SystemContext) => Promise<T>,
): Promise<T> {
  return businessId === null
    ? deps.db.forAgency(key.agencyId).run(fn)
    : deps.db.forBusiness(businessId, { agencyId: key.agencyId }).run(fn);
}

const actorOf = (key: ApiKeyRef) => ({ type: "api_key" as const, label: key.name });

/** `POST /api/v1/knowledge/import`: JSON records for one or more businesses. */
export async function handleImportRequest(
  request: Request,
  deps: ImportApiDeps,
): Promise<Response> {
  const caller = await authenticate(request, deps, IMPORT_SCOPE_WRITE);
  if (caller instanceof Response) return caller;
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) {
    return failure(415, "unsupported_media_type", "Send the records as application/json.");
  }
  const text = await readBody(request, MAX_JSON_BYTES);
  if (text instanceof Response) return text;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return failure(400, "invalid_json", "The request body is not valid JSON.");
  }
  const now = (deps.clock ?? (() => new Date()))();
  try {
    const outcome = await runScoped(deps, caller.key, caller.key.businessId, (ctx) =>
      importApiRecords(ctx, {
        agencyId: caller.key.agencyId,
        businessId: caller.key.businessId,
        body,
        actor: actorOf(caller.key),
        now,
      }),
    );
    if (!outcome.ok) {
      return failure(400, "invalid_request", "The request is not an import request.", {
        problems: outcome.problems,
      });
    }
    deps.logger.info("import_api.imported", {
      traceId: caller.traceId,
      agencyId: caller.key.agencyId,
      apiKeyId: caller.key.id,
      kind: "api",
      status: outcome.result.status,
      importRunId: outcome.result.importRunId,
    });
    return resultResponse(outcome.result);
  } catch (error) {
    return errorResponse(error, deps, caller);
  }
}

interface CsvUpload {
  readonly csv: string;
  readonly fileName: string | null;
  readonly params: URLSearchParams;
}

async function readCsvUpload(request: Request): Promise<CsvUpload | Response> {
  const params = new URL(request.url).searchParams;
  const type = request.headers.get("content-type") ?? "";
  const limit = CSV_LIMITS.maxBytes;
  if (/^multipart\/form-data\b/i.test(type)) {
    const declared = Number(request.headers.get("content-length") ?? "0");
    // A little room for the other fields and the boundaries.
    if (!Number.isFinite(declared) || declared === 0 || declared > limit + 64 * 1024) {
      return failure(
        declared === 0 ? 411 : 413,
        declared === 0 ? "length_required" : "too_large",
        `Send the upload with its length; a file may be at most ${limit} bytes.`,
      );
    }
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return failure(400, "invalid_request", "The upload could not be read as form data.");
    }
    const file = form.get("file");
    if (file === null || typeof file === "string") {
      return failure(400, "invalid_request", 'The form needs a "file" field with the CSV file.');
    }
    if (file.size > limit) {
      return failure(413, "too_large", `The file is too large: at most ${limit} bytes.`);
    }
    for (const [name, value] of form.entries()) {
      if (name !== "file" && typeof value === "string" && !params.has(name))
        params.set(name, value);
    }
    return { csv: await file.text(), fileName: file.name.length > 0 ? file.name : null, params };
  }
  if (!/^text\/(csv|plain)\b/i.test(type)) {
    return failure(
      415,
      "unsupported_media_type",
      "Send the file as text/csv, or as multipart/form-data with a file field.",
    );
  }
  const csv = await readBody(request, limit);
  if (csv instanceof Response) return csv;
  return { csv, fileName: params.get("file_name"), params };
}

const MODES: readonly ImportMode[] = ["merge", "replace"];
const PROFILE_MODES: readonly ProfileMode[] = ["fill_empty", "overwrite", "ignore"];

async function businessByReference(
  deps: ImportApiDeps,
  agencyId: AgencyId,
  externalRef: string,
): Promise<BusinessId | null> {
  const rows = await deps.db.forAgency(agencyId).run(
    (ctx) =>
      ctx.tx
        .select({ id: businesses.id })
        .from(businesses)
        .where(and(eq(businesses.agencyId, agencyId), eq(businesses.externalRef, externalRef)))
        .limit(1),
    { readOnly: true },
  );
  return rows[0]?.id ?? null;
}

/**
 * `POST /api/v1/knowledge/import/csv`. Parameters (query string, or form fields):
 * `business_id` or `external_ref` (the business the file is for; omit both for a file with a
 * reference column, agency keys only), `mode`, `profile_mode`, `mapping` (JSON: column name
 * to target; default: guessed from the column names) and `file_name`.
 */
export async function handleCsvImportRequest(
  request: Request,
  deps: ImportApiDeps,
): Promise<Response> {
  const caller = await authenticate(request, deps, IMPORT_SCOPE_WRITE);
  if (caller instanceof Response) return caller;
  const upload = await readCsvUpload(request);
  if (upload instanceof Response) return upload;
  const { params } = upload;

  const mode = params.get("mode") ?? "merge";
  const profileMode = params.get("profile_mode") ?? "fill_empty";
  if (!(MODES as readonly string[]).includes(mode)) {
    return failure(400, "invalid_request", 'mode is "merge" or "replace".');
  }
  if (!(PROFILE_MODES as readonly string[]).includes(profileMode)) {
    return failure(
      400,
      "invalid_request",
      'profile_mode is "fill_empty", "overwrite" or "ignore".',
    );
  }
  let mapping: ColumnMapping | undefined;
  const rawMapping = params.get("mapping");
  if (rawMapping !== null && rawMapping.trim().length > 0) {
    let value: unknown;
    try {
      value = JSON.parse(rawMapping);
    } catch {
      return failure(400, "invalid_request", "mapping is not valid JSON.");
    }
    const parsed = ColumnMapping.safeParse(value);
    if (!parsed.success) {
      return failure(400, "invalid_request", "mapping is not a column mapping.", {
        problems: parsed.error.issues.map((issue) => ({
          column: issue.path.map(String).join(".") || null,
          message: issue.message,
        })),
      });
    }
    mapping = parsed.data;
  }

  try {
    // Which business: the key's own, the one named, or none (a file with a reference column).
    let businessId = caller.key.businessId;
    const namedId = params.get("business_id");
    const namedRef = params.get("external_ref");
    if (namedId !== null) {
      const parsed = BusinessId.safeParse(namedId);
      if (!parsed.success) return failure(400, "invalid_request", "business_id is not an id.");
      if (businessId !== null && businessId !== parsed.data) {
        return failure(403, "forbidden", "The API key cannot write this business.");
      }
      businessId = parsed.data;
    } else if (namedRef !== null) {
      const found = await businessByReference(deps, caller.key.agencyId, namedRef);
      if (found === null) return failure(404, "not_found", "No business has this reference.");
      if (businessId !== null && businessId !== found) {
        return failure(403, "forbidden", "The API key cannot write this business.");
      }
      businessId = found;
    }

    const now = (deps.clock ?? (() => new Date()))();
    const result = await runScoped(deps, caller.key, businessId, (ctx) =>
      importCsv(ctx, {
        agencyId: caller.key.agencyId,
        businessId,
        csv: upload.csv,
        fileName: upload.fileName,
        ...(mapping === undefined ? {} : { mapping }),
        mode: mode as ImportMode,
        profileMode: profileMode as ProfileMode,
        actor: actorOf(caller.key),
        now,
      }),
    );
    deps.logger.info("import_api.imported", {
      traceId: caller.traceId,
      agencyId: caller.key.agencyId,
      apiKeyId: caller.key.id,
      kind: "csv",
      status: result.status,
      importRunId: result.importRunId,
    });
    return resultResponse(result, { mapping: result.mapping });
  } catch (error) {
    return errorResponse(error, deps, caller);
  }
}

/** `GET /api/v1/knowledge/imports/{id}`: one import run of the caller's tenant. */
export async function handleImportStatusRequest(
  request: Request,
  importRunId: string,
  deps: ImportApiDeps,
): Promise<Response> {
  const caller = await authenticate(request, deps, IMPORT_SCOPE_READ);
  if (caller instanceof Response) return caller;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(importRunId)) {
    return failure(404, "not_found", "No such import.");
  }
  try {
    // Row-level security keeps the scope to the key's business or agency.
    const rows = await runScoped(deps, caller.key, caller.key.businessId, (ctx) =>
      ctx.tx.select().from(importRuns).where(eq(importRuns.id, importRunId)).limit(1),
    );
    const run = rows[0];
    if (run === undefined) return failure(404, "not_found", "No such import.");
    return json(200, {
      importRunId: run.id,
      businessId: run.businessId,
      kind: run.kind,
      status: run.status,
      fileName: run.fileName,
      stats: run.stats,
      problems: run.errors,
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null,
    });
  } catch (error) {
    return errorResponse(error, deps, caller);
  }
}
