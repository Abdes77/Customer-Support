import { z } from "zod";

import {
  type BusinessId,
  KNOWLEDGE_CATEGORIES,
  KnowledgeCategory,
  NotFoundError,
  type UserId,
  ValidationError,
} from "@repo/core";
import {
  and,
  asc,
  type AuditActor,
  type BusinessContext,
  type BusinessTenant,
  count,
  type DbContext,
  eq,
  type KnowledgeItemStatus,
  knowledgeItems,
  max,
  recordSystemAudit,
  recordUserAudit,
  type UserContext,
} from "@repo/db";

import { cleanLine, cleanText } from "./text";

/**
 * Knowledge items: the facts about one business (services, service area, hours, licences,
 * warranties, financing, team, brands, reviews, differentiators...). Every fact has a
 * category, a source and the time it was last changed or confirmed, and can be edited,
 * archived, pinned and ordered in the admin panel.
 *
 * Functions take a database context: a signed-in member of staff (row-level security
 * applies) or the system scope. Role checks for users are in `service.ts`.
 */

/** A business holds at most this many active facts: every one of them can reach a prompt. */
export const MAX_ACTIVE_FACTS = 300;

export const MAX_FACT_TITLE = 200;
export const MAX_FACT_CONTENT = 4000;

/** Where a fact came from. A website fact carries the address of its page instead. */
export const FACT_SOURCES = ["manual", "csv_import", "api", "website"] as const;
export type FactSource = (typeof FACT_SOURCES)[number];

const title = z
  .string()
  .transform(cleanLine)
  .pipe(z.string().max(MAX_FACT_TITLE, `A title has at most ${MAX_FACT_TITLE} characters.`));
const content = z
  .string()
  .transform(cleanText)
  .pipe(
    z
      .string()
      .min(1, "A fact needs some text.")
      .max(MAX_FACT_CONTENT, `A fact has at most ${MAX_FACT_CONTENT} characters.`),
  );

/** What a person or an import supplies for one fact. */
export const KnowledgeItemInput = z.object({
  category: KnowledgeCategory,
  title: title.default(""),
  content,
  /** In every reply, whatever its category (`knowledge.core_categories` covers the rest). */
  pinned: z.boolean().optional(),
});
export type KnowledgeItemInput = z.infer<typeof KnowledgeItemInput>;

export const KnowledgeItemPatch = z
  .object({
    category: KnowledgeCategory,
    title,
    content,
    pinned: z.boolean(),
    position: z.number().int().min(0).max(100_000),
  })
  .partial();
export type KnowledgeItemPatch = z.infer<typeof KnowledgeItemPatch>;

export interface KnowledgeItemRecord {
  readonly id: string;
  readonly category: KnowledgeCategory;
  readonly title: string;
  readonly content: string;
  /** "manual", "csv_import", "api", "website" or the address of a web page. */
  readonly source: string | null;
  readonly importRunId: string | null;
  /** Set for facts that came from an import or a crawl. */
  readonly importKey: string | null;
  readonly pinned: boolean;
  readonly status: KnowledgeItemStatus;
  readonly position: number;
  /** A person changed the fact after it was imported: imports no longer overwrite it. */
  readonly handEdited: boolean;
  readonly updatedBy: UserId | null;
  readonly createdAt: string;
  /** When the fact was last changed or confirmed. */
  readonly updatedAt: string;
  /** Not confirmed for longer than `knowledge.stale_after_days`. The bot still uses it. */
  readonly stale: boolean;
}

type Row = typeof knowledgeItems.$inferSelect;

export function isHandEdited(metadata: Record<string, unknown>): boolean {
  return metadata["handEdited"] === true;
}

export function toRecord(row: Row, staleBefore: Date | null = null): KnowledgeItemRecord {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    content: row.content,
    source: row.source,
    importRunId: row.importRunId,
    importKey: row.importKey,
    pinned: row.isCore,
    status: row.status,
    position: row.position,
    handEdited: isHandEdited(row.metadata),
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    stale:
      staleBefore !== null &&
      row.status === "active" &&
      row.updatedAt.getTime() < staleBefore.getTime(),
  };
}

const categoryOrder = (category: string) => {
  const index = (KNOWLEDGE_CATEGORIES as readonly string[]).indexOf(category);
  return index === -1 ? KNOWLEDGE_CATEGORIES.length : index;
};

export interface ListKnowledgeOptions {
  readonly category?: KnowledgeCategory;
  /** Default "active". */
  readonly status?: KnowledgeItemStatus | "all";
  /** `knowledge.stale_after_days`; null or absent: nothing is flagged. */
  readonly staleAfterDays?: number | null;
  readonly now?: Date;
}

/** The business's facts in display order: by category, then position. */
export async function listKnowledgeItems(
  ctx: DbContext,
  businessId: BusinessId,
  options: ListKnowledgeOptions = {},
): Promise<KnowledgeItemRecord[]> {
  const status = options.status ?? "active";
  const rows = await ctx.tx
    .select()
    .from(knowledgeItems)
    .where(
      and(
        eq(knowledgeItems.businessId, businessId),
        status === "all" ? undefined : eq(knowledgeItems.status, status),
        options.category === undefined ? undefined : eq(knowledgeItems.category, options.category),
      ),
    )
    .orderBy(asc(knowledgeItems.position), asc(knowledgeItems.createdAt), asc(knowledgeItems.id));
  const days = options.staleAfterDays ?? null;
  const staleBefore =
    days === null ? null : new Date((options.now ?? new Date()).getTime() - days * 86_400_000);
  return rows
    .sort((a, b) => categoryOrder(a.category) - categoryOrder(b.category))
    .map((row) => toRecord(row, staleBefore));
}

type WriteContext = UserContext | BusinessContext;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new ValidationError(
    parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "fact"}: ${issue.message}`)
      .join("; "),
    {
      details: {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    },
  );
}

async function audit(
  ctx: WriteContext,
  tenant: BusinessTenant,
  actor: AuditActor | undefined,
  entry: { readonly action: string; readonly id: string; readonly summary: string },
): Promise<void> {
  const body = {
    action: entry.action,
    targetType: "knowledge_item",
    targetId: entry.id,
    // Category and title, never the text of the fact.
    summary: entry.summary,
  };
  if (ctx.kind === "user") await recordUserAudit(ctx, tenant, body);
  else await recordSystemAudit(ctx, actor ?? { type: "system", label: "knowledge" }, body);
}

function editor(ctx: WriteContext, actor: AuditActor | undefined): UserId | null {
  if (ctx.kind === "user") return ctx.user.id;
  return actor?.type === "user" ? actor.userId : null;
}

/** Throws when the business already holds the most active facts it may. */
export async function assertRoomForFacts(
  ctx: DbContext,
  businessId: BusinessId,
  adding: number,
): Promise<void> {
  const [row] = await ctx.tx
    .select({ value: count() })
    .from(knowledgeItems)
    .where(and(eq(knowledgeItems.businessId, businessId), eq(knowledgeItems.status, "active")));
  const active = row?.value ?? 0;
  if (active + adding > MAX_ACTIVE_FACTS) {
    throw new ValidationError(
      `A business can hold ${MAX_ACTIVE_FACTS} active facts; this would make ${active + adding}. Archive or merge some first.`,
      { details: { active, adding, limit: MAX_ACTIVE_FACTS } },
    );
  }
}

async function nextPosition(
  ctx: DbContext,
  businessId: BusinessId,
  category: KnowledgeCategory,
): Promise<number> {
  const [row] = await ctx.tx
    .select({ value: max(knowledgeItems.position) })
    .from(knowledgeItems)
    .where(and(eq(knowledgeItems.businessId, businessId), eq(knowledgeItems.category, category)));
  return (row?.value ?? -1) + 1;
}

/** Adds a fact written by a person. */
export async function createKnowledgeItem(
  ctx: WriteContext,
  input: { readonly tenant: BusinessTenant; readonly item: unknown; readonly actor?: AuditActor },
): Promise<KnowledgeItemRecord> {
  const item = parse(KnowledgeItemInput, input.item);
  await assertRoomForFacts(ctx, input.tenant.businessId, 1);
  const [row] = await ctx.tx
    .insert(knowledgeItems)
    .values({
      ...input.tenant,
      category: item.category,
      title: item.title,
      content: item.content,
      source: "manual",
      isCore: item.pinned ?? false,
      position: await nextPosition(ctx, input.tenant.businessId, item.category),
      updatedBy: editor(ctx, input.actor),
    })
    .returning();
  if (row === undefined) throw new Error("Insert into knowledge_items returned no row");
  await audit(ctx, input.tenant, input.actor, {
    action: "knowledge.create",
    id: row.id,
    summary: `Fact added: ${row.category}${row.title.length > 0 ? ` / ${row.title}` : ""}`,
  });
  return toRecord(row);
}

async function requireItem(ctx: DbContext, tenant: BusinessTenant, id: string): Promise<Row> {
  const [row] = await ctx.tx
    .select()
    .from(knowledgeItems)
    .where(and(eq(knowledgeItems.id, id), eq(knowledgeItems.businessId, tenant.businessId)))
    .limit(1);
  if (row === undefined) throw new NotFoundError("Fact not found.", { details: { id } });
  return row;
}

/**
 * Changes a fact. A change to the wording or the category of an imported fact marks it as
 * edited by hand, so that a later import of the same data leaves the person's version alone.
 */
export async function updateKnowledgeItem(
  ctx: WriteContext,
  input: {
    readonly tenant: BusinessTenant;
    readonly id: string;
    readonly patch: unknown;
    readonly actor?: AuditActor;
  },
): Promise<KnowledgeItemRecord> {
  const patch = parse(KnowledgeItemPatch, input.patch);
  const current = await requireItem(ctx, input.tenant, input.id);
  const reworded =
    (patch.title !== undefined && patch.title !== current.title) ||
    (patch.content !== undefined && patch.content !== current.content) ||
    (patch.category !== undefined && patch.category !== current.category);
  const [row] = await ctx.tx
    .update(knowledgeItems)
    .set({
      ...(patch.category === undefined ? {} : { category: patch.category }),
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.content === undefined ? {} : { content: patch.content }),
      ...(patch.pinned === undefined ? {} : { isCore: patch.pinned }),
      ...(patch.position === undefined ? {} : { position: patch.position }),
      ...(reworded && current.importKey !== null
        ? { metadata: { ...current.metadata, handEdited: true } }
        : {}),
      updatedBy: editor(ctx, input.actor),
    })
    .where(eq(knowledgeItems.id, current.id))
    .returning();
  if (row === undefined) throw new NotFoundError("Fact not found.", { details: { id: input.id } });
  await audit(ctx, input.tenant, input.actor, {
    action: "knowledge.update",
    id: row.id,
    summary: `Fact changed: ${row.category}${row.title.length > 0 ? ` / ${row.title}` : ""}`,
  });
  return toRecord(row);
}

/**
 * Archives or restores a fact. The bot stops using an archived fact; an import does not
 * bring back a fact a person archived.
 */
export async function setKnowledgeItemStatus(
  ctx: WriteContext,
  input: {
    readonly tenant: BusinessTenant;
    readonly id: string;
    readonly status: KnowledgeItemStatus;
    readonly actor?: AuditActor;
  },
): Promise<KnowledgeItemRecord> {
  const current = await requireItem(ctx, input.tenant, input.id);
  if (input.status === "active" && current.status !== "active") {
    await assertRoomForFacts(ctx, input.tenant.businessId, 1);
  }
  const { archivedBy: _archivedBy, ...kept } = current.metadata;
  const [row] = await ctx.tx
    .update(knowledgeItems)
    .set({
      status: input.status,
      metadata: input.status === "archived" ? { ...kept, archivedBy: "user" } : kept,
      updatedBy: editor(ctx, input.actor),
    })
    .where(eq(knowledgeItems.id, current.id))
    .returning();
  if (row === undefined) throw new NotFoundError("Fact not found.", { details: { id: input.id } });
  await audit(ctx, input.tenant, input.actor, {
    action: input.status === "archived" ? "knowledge.archive" : "knowledge.restore",
    id: row.id,
    summary: `Fact ${input.status === "archived" ? "archived" : "restored"}: ${row.category}${
      row.title.length > 0 ? ` / ${row.title}` : ""
    }`,
  });
  return toRecord(row);
}

/** Marks a fact as still true today: its last-updated time moves, its text does not. */
export async function confirmKnowledgeItem(
  ctx: WriteContext,
  input: { readonly tenant: BusinessTenant; readonly id: string; readonly actor?: AuditActor },
): Promise<KnowledgeItemRecord> {
  const current = await requireItem(ctx, input.tenant, input.id);
  const [row] = await ctx.tx
    .update(knowledgeItems)
    .set({ updatedBy: editor(ctx, input.actor) })
    .where(eq(knowledgeItems.id, current.id))
    .returning();
  if (row === undefined) throw new NotFoundError("Fact not found.", { details: { id: input.id } });
  return toRecord(row);
}

export async function deleteKnowledgeItem(
  ctx: WriteContext,
  input: { readonly tenant: BusinessTenant; readonly id: string; readonly actor?: AuditActor },
): Promise<void> {
  const current = await requireItem(ctx, input.tenant, input.id);
  await ctx.tx.delete(knowledgeItems).where(eq(knowledgeItems.id, current.id));
  await audit(ctx, input.tenant, input.actor, {
    action: "knowledge.delete",
    id: current.id,
    summary: `Fact deleted: ${current.category}${current.title.length > 0 ? ` / ${current.title}` : ""}`,
  });
}
