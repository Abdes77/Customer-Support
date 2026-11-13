/**
 * Structured JSON logger with redaction. It has no dependencies so it runs in Node, the edge
 * and tests. Process-wide listeners (`addLogListener`) see every record after redaction; C17
 * reports error records to Sentry through one, without changing call sites.
 *
 * Rules for callers:
 * - Log ids, counts, durations and outcomes. Never log message bodies, emails, phone numbers,
 *   tokens or full provider payloads; those belong in tenant-scoped database rows.
 * - Always bind `traceId` and `businessId` when they are known.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Readonly<Record<string, unknown>>;

export interface LogRecord {
  readonly level: LogLevel;
  readonly time: string;
  readonly msg: string;
  readonly [field: string]: unknown;
}

export type LogSink = (record: LogRecord) => void;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Returns a logger that adds `bindings` to every record. */
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly sink?: LogSink;
  readonly bindings?: LogFields;
  readonly now?: () => Date;
}

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export const REDACTED = "[redacted]";

/**
 * Field names that hold credentials, matched as substrings of the normalized name (lower case,
 * with `_` and `-` removed, so `api_key`, `apiKey` and `ANTHROPIC_API_KEY` all match
 * "apikey"). Numbers and booleans under these names are kept, so token counts (`inputTokens`)
 * and flags (`hasSecret`) stay readable; strings, arrays and objects are replaced.
 * The list covers every secret in the env spec by name (a test in `env/env.test.ts` checks it),
 * including connection strings, which embed a password.
 */
const SECRET_KEY_PARTS = [
  "authorization",
  "cookie",
  "password",
  "secret",
  "token",
  "apikey",
  "credential",
  "signature",
  "privatekey",
  "servicerolekey",
  "signingkey",
  "eventkey",
  "appkey",
  "encryptionkey",
  "accesskey",
  "clientstate",
  "databaseurl",
  "connectionstring",
  "smtpurl",
] as const;

/** Field names (normalized as above) that carry customer content or contact details. */
const PERSONAL_DATA_KEYS = new Set([
  "body",
  "rawbody",
  "text",
  "html",
  "content",
  "subject",
  "email",
  "phone",
  "address",
  "displayname",
  "firstname",
  "lastname",
  "fullname",
  "customername",
  "contactname",
  "sendername",
  "raw",
  "payload",
]);

const MAX_DEPTH = 6;

function mustRedact(key: string, value: unknown): boolean {
  if (value == null) return false;
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  if (PERSONAL_DATA_KEYS.has(normalized)) return true;
  if (typeof value === "number" || typeof value === "boolean") return false;
  return SECRET_KEY_PARTS.some((part) => normalized.includes(part));
}

function serializeError(error: Error, depth: number, ancestors: Set<object>): unknown {
  const out: Record<string, unknown> = { name: error.name, message: error.message };
  if (error.stack !== undefined) out["stack"] = error.stack;
  for (const key of ["code", "retryable", "provider", "status", "details"] as const) {
    const value = (error as unknown as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = redact(value, depth + 1, ancestors);
  }
  if (error.cause !== undefined) out["cause"] = redact(error.cause, depth + 1, ancestors);
  return out;
}

function redactObject(value: object, depth: number, ancestors: Set<object>): unknown {
  if (value instanceof Error) return serializeError(value, depth, ancestors);
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, ancestors));

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = mustRedact(key, inner) ? REDACTED : redact(inner, depth + 1, ancestors);
  }
  return out;
}

/**
 * Returns a copy of `value` that is safe to log: credentials and personal data are replaced.
 * Redaction is by field name, so free text (an error message, a string in an array) is not
 * inspected: keep customer text and tokens out of messages and unnamed values.
 */
export function redact(value: unknown, depth = 0, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value !== "object") {
    return typeof value === "bigint" ? value.toString() : value;
  }
  if (value instanceof Date) return value.toISOString();
  if (ancestors.has(value)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[truncated]";

  ancestors.add(value);
  try {
    return redactObject(value, depth, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

const consoleSink: LogSink = (record) => {
  const line = JSON.stringify(record);
  if (record.level === "error") console.error(line);
  else if (record.level === "warn") console.warn(line);
  else console.log(line);
};

function levelFromEnv(): LogLevel {
  const raw = typeof process === "undefined" ? undefined : process.env["LOG_LEVEL"];
  return raw === "debug" || raw === "info" || raw === "warn" || raw === "error" ? raw : "info";
}

/**
 * Receives every record a logger writes, after redaction (C17: error reporting to Sentry).
 * Listeners run after the sink; one that throws is ignored, so reporting can never break
 * the code that logged.
 */
export type LogListener = (record: LogRecord) => void;

const listeners = new Set<LogListener>();

/** Adds a process-wide listener; returns the function that removes it again. */
export function addLogListener(listener: LogListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(record: LogRecord): void {
  for (const listener of listeners) {
    try {
      listener(record);
    } catch {
      // Reporting must never break the code that logged.
    }
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = LEVEL_ORDER[options.level ?? levelFromEnv()];
  const sink = options.sink ?? consoleSink;
  const bindings = options.bindings ?? {};
  const now = options.now ?? (() => new Date());

  function write(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < threshold) return;
    const safe = redact({ ...bindings, ...fields }) as Record<string, unknown>;
    const record: LogRecord = { ...safe, level, time: now().toISOString(), msg };
    sink(record);
    if (listeners.size > 0) notify(record);
  }

  return {
    debug: (msg, fields) => write("debug", msg, fields),
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
    child: (extra) => createLogger({ ...options, bindings: { ...bindings, ...extra } }),
  };
}

/** Process-wide default logger. Prefer `logger.child({ traceId, businessId })` in request code. */
export const logger: Logger = createLogger();
