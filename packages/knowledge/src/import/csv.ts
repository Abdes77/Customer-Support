/**
 * A CSV reader for uploaded lead-generation data (RFC 4180, as spreadsheets write it):
 * quoted fields, doubled quotes inside them, line breaks inside quoted fields, CRLF, LF or
 * CR line ends, a byte-order mark, and comma, semicolon or tab as the delimiter.
 *
 * It never throws on bad input: a file that cannot be read comes back as a failure with a
 * message for the person who uploaded it. Rows that are merely the wrong shape are kept, so
 * the mapping step can report each one by its number.
 */

export interface CsvLimits {
  readonly maxBytes: number;
  readonly maxRows: number;
  readonly maxColumns: number;
}

export const CSV_LIMITS: CsvLimits = {
  /** Size of the file as text. */
  maxBytes: 5 * 1024 * 1024,
  /** Data rows, the header not counted. */
  maxRows: 5000,
  maxColumns: 100,
};

export type CsvDelimiter = "," | ";" | "\t";

export interface CsvRow {
  /** The row's number as a spreadsheet shows it: the header is row 1. */
  readonly number: number;
  readonly cells: readonly string[];
}

export interface ParsedCsv {
  readonly ok: true;
  readonly delimiter: CsvDelimiter;
  readonly headers: readonly string[];
  /** Rows with at least one non-empty cell. */
  readonly rows: readonly CsvRow[];
}

export interface CsvFailure {
  readonly ok: false;
  /** One sentence for the person who uploaded the file. */
  readonly message: string;
  readonly row: number | null;
}

const DELIMITERS: readonly CsvDelimiter[] = [",", ";", "\t"];

/** The delimiter that splits the first line into the most fields, outside quotes. */
export function detectDelimiter(text: string): CsvDelimiter {
  const counts = new Map<CsvDelimiter, number>(DELIMITERS.map((delimiter) => [delimiter, 0]));
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === "\n" || char === "\r")) break;
    else if (!quoted && DELIMITERS.includes(char as CsvDelimiter)) {
      counts.set(char as CsvDelimiter, (counts.get(char as CsvDelimiter) ?? 0) + 1);
    }
  }
  let best: CsvDelimiter = ",";
  for (const delimiter of DELIMITERS) {
    if ((counts.get(delimiter) ?? 0) > (counts.get(best) ?? 0)) best = delimiter;
  }
  return best;
}

function fail(message: string, row: number | null = null): CsvFailure {
  return { ok: false, message, row };
}

export function parseCsv(
  input: string,
  options: {
    readonly delimiter?: CsvDelimiter;
    readonly limits?: Partial<CsvLimits>;
  } = {},
): ParsedCsv | CsvFailure {
  const limits = { ...CSV_LIMITS, ...options.limits };
  if (input.length > limits.maxBytes) {
    return fail(
      `The file is too large: at most ${Math.round(limits.maxBytes / (1024 * 1024))} MB of CSV.`,
    );
  }
  if (input.includes("\u0000")) {
    return fail("This does not look like a CSV file (it contains binary data). Export it as CSV.");
  }
  const text = input.startsWith("﻿") ? input.slice(1) : input;
  if (text.trim().length === 0) return fail("The file is empty.");
  const delimiter = options.delimiter ?? detectDelimiter(text);

  const records: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  /** True once the current cell has had a quoted part: text after the closing quote is kept. */
  let wasQuoted = false;
  /** Length of the cell when its quoted part closed: spaces typed after it are not content. */
  let closedAt = 0;
  let line = 1;
  let recordLine = 1;
  let quoteLine = 0;

  const endCell = () => {
    cells.push(wasQuoted ? cell.slice(0, closedAt) + cell.slice(closedAt).trimEnd() : cell.trim());
    cell = "";
    wasQuoted = false;
    closedAt = 0;
  };
  const endRecord = () => {
    endCell();
    records.push({ line: recordLine, cells });
    cells = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (quoted) {
      if (char === '"') {
        if (text.charAt(index + 1) === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
          closedAt = cell.length;
        }
      } else {
        if (char === "\n") line += 1;
        cell += char === "\r" ? "" : char;
      }
      continue;
    }
    if (char === '"' && cell.trim().length === 0) {
      // An opening quote, possibly after spaces.
      quoted = true;
      wasQuoted = true;
      quoteLine = line;
      cell = "";
    } else if (char === delimiter) {
      endCell();
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text.charAt(index + 1) === "\n") index += 1;
      endRecord();
      line += 1;
      recordLine = line;
      if (records.length > limits.maxRows + 1 + 1000) {
        // Far past the limit: stop reading instead of holding a huge file in memory.
        return fail(`The file has too many rows: at most ${limits.maxRows}.`);
      }
    } else {
      cell += char;
    }
  }
  if (quoted) {
    return fail(
      `A quoted field that starts on line ${quoteLine} is never closed. Check for a stray quotation mark.`,
      quoteLine,
    );
  }
  if (cell.length > 0 || cells.length > 0) endRecord();

  const [header, ...body] = records;
  if (header === undefined) return fail("The file is empty.");
  const headers = header.cells.map((name) => name.replaceAll(/\s+/g, " ").trim());
  while (headers.length > 0 && headers.at(-1) === "") headers.pop();
  if (headers.length === 0) return fail("The first row has no column names.", 1);
  if (headers.length > limits.maxColumns) {
    return fail(`The file has too many columns: at most ${limits.maxColumns}.`, 1);
  }
  const blank = headers.findIndex((name) => name.length === 0);
  if (blank !== -1) {
    return fail(`Column ${blank + 1} has no name in the first row.`, 1);
  }
  const seen = new Map<string, number>();
  for (const [index, name] of headers.entries()) {
    const key = name.toLowerCase();
    const first = seen.get(key);
    if (first !== undefined) {
      return fail(
        `Two columns are named "${name.slice(0, 60)}" (columns ${first + 1} and ${index + 1}). Rename one of them.`,
        1,
      );
    }
    seen.set(key, index);
  }

  const rows: CsvRow[] = [];
  body.forEach((record, index) => {
    if (record.cells.every((value) => value.trim().length === 0)) return;
    // Row numbers count records, as a spreadsheet does, not physical lines.
    rows.push({ number: index + 2, cells: record.cells });
  });
  if (rows.length === 0) return fail("The file has column names but no rows.");
  if (rows.length > limits.maxRows) {
    return fail(
      `The file has ${rows.length} rows: at most ${limits.maxRows} can be imported at once.`,
    );
  }
  return { ok: true, delimiter, headers, rows };
}
