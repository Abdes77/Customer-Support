"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { ColumnMapping, CSV_LIMITS, type CsvPreview, previewCsv } from "@repo/knowledge";

import { type ActionResult, actionBusiness, runAction } from "@/server/admin";
import { ActionError } from "@/server/admin/result";
import { getKnowledge } from "@/server/knowledge";

/*
 * Server actions for business knowledge (C6's services). Agency staff edit; the knowledge
 * service checks the role again and refuses client users. Imported and typed text is stored
 * as text and only ever rendered as text.
 */

/** Uploads stay under the server-action body limit (next.config.ts) with room to spare. */
const MAX_CSV_CHARS = Math.min(CSV_LIMITS.maxBytes, 3_500_000);

const CsvText = z
  .string()
  .min(1, "The file is empty.")
  .max(
    MAX_CSV_CHARS,
    "The file is too large for an upload here (3.5 MB at most). Use the import API for larger files.",
  );

const PreviewInput = z.strictObject({
  businessId: z.string(),
  csv: CsvText,
  mapping: ColumnMapping.optional(),
});

const ImportInput = z.strictObject({
  businessId: z.string(),
  csv: CsvText,
  fileName: z.string().trim().max(200).nullable(),
  mapping: ColumnMapping,
  mode: z.enum(["merge", "replace"]),
});

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ActionError(parsed.error.issues[0]?.message ?? "That request could not be read.");
  }
  return parsed.data;
}

/** What an import of the file would do, with the suggested or the given mapping. Writes nothing. */
export async function previewCsvAction(input: unknown): Promise<ActionResult<CsvPreview>> {
  return runAction("knowledge.preview_csv", async (session) => {
    const data = parse(PreviewInput, input);
    await actionBusiness(session, data.businessId);
    return previewCsv(data.csv, data.mapping === undefined ? {} : { mapping: data.mapping });
  });
}

export interface ImportOutcome {
  readonly status: string;
  readonly stats: Readonly<Record<string, number>>;
  readonly problems: readonly {
    readonly row: number | null;
    readonly column: string | null;
    readonly message: string;
  }[];
}

export async function importCsvAction(input: unknown): Promise<ActionResult<ImportOutcome>> {
  return runAction("knowledge.import_csv", async (session) => {
    const data = parse(ImportInput, input);
    const { business } = await actionBusiness(session, data.businessId);
    const result = await getKnowledge().knowledge.importCsv(session.user, {
      businessId: business.id,
      csv: data.csv,
      fileName: data.fileName,
      mapping: data.mapping,
      mode: data.mode,
      profileMode: "fill_empty",
    });
    revalidatePath(`/businesses/${business.id}`, "layout");
    return {
      status: result.status,
      stats: { ...result.stats },
      problems: result.problems.slice(0, 50).map((problem) => ({
        row: problem.row ?? null,
        column: problem.column ?? null,
        message: problem.message,
      })),
    };
  });
}

/** Asks for the business's website to be read (when `knowledge.website_crawl` allows it). */
export async function crawlWebsiteAction(
  input: unknown,
): Promise<ActionResult<{ started: boolean }>> {
  return runAction("knowledge.crawl", async (session) => {
    const { businessId } = parse(z.strictObject({ businessId: z.string() }), input);
    const { business } = await actionBusiness(session, businessId);
    const result = await getKnowledge().knowledge.crawlWebsite(session.user, business.id);
    revalidatePath(`/businesses/${business.id}`, "layout");
    return { started: result.started };
  });
}

const FactInput = z.strictObject({
  businessId: z.string(),
  item: z.strictObject({
    category: z.string(),
    title: z.string(),
    content: z.string(),
    pinned: z.boolean(),
  }),
});

export async function createFactAction(input: unknown): Promise<ActionResult<null>> {
  return runAction("knowledge.create", async (session) => {
    const data = parse(FactInput, input);
    const { business } = await actionBusiness(session, data.businessId);
    await getKnowledge().knowledge.create(session.user, business.id, data.item);
    revalidatePath(`/businesses/${business.id}/knowledge`);
    return null;
  });
}

const UpdateInput = z.strictObject({
  businessId: z.string(),
  id: z.uuid(),
  patch: z.strictObject({
    category: z.string().optional(),
    title: z.string().optional(),
    content: z.string().optional(),
    pinned: z.boolean().optional(),
  }),
});

export async function updateFactAction(input: unknown): Promise<ActionResult<null>> {
  return runAction("knowledge.update", async (session) => {
    const data = parse(UpdateInput, input);
    const { business } = await actionBusiness(session, data.businessId);
    await getKnowledge().knowledge.update(session.user, business.id, data.id, data.patch);
    revalidatePath(`/businesses/${business.id}/knowledge`);
    return null;
  });
}

const FactOperation = z.strictObject({
  businessId: z.string(),
  id: z.uuid(),
  operation: z.enum(["archive", "restore", "confirm", "remove"]),
});

export async function factOperationAction(input: unknown): Promise<ActionResult<null>> {
  return runAction("knowledge.operation", async (session) => {
    const data = parse(FactOperation, input);
    const { business } = await actionBusiness(session, data.businessId);
    const knowledge = getKnowledge().knowledge;
    switch (data.operation) {
      case "archive":
        await knowledge.archive(session.user, business.id, data.id);
        break;
      case "restore":
        await knowledge.restore(session.user, business.id, data.id);
        break;
      case "confirm":
        await knowledge.confirm(session.user, business.id, data.id);
        break;
      case "remove":
        await knowledge.remove(session.user, business.id, data.id);
        break;
    }
    revalidatePath(`/businesses/${business.id}/knowledge`);
    return null;
  });
}
