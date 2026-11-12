import {
  type AgencyId,
  type BusinessId,
  isAgencyRole,
  type KnowledgeCategory,
  type Logger,
  NotFoundError,
  type Role,
  TenantAccessError,
} from "@repo/core";
import {
  and,
  businesses,
  type BusinessTenant,
  type Database,
  desc,
  eq,
  type ImportRunKind,
  importRuns,
  type ImportRunStatus,
  isNull,
  type KnowledgeItemStatus,
  loadUserAccess,
  requireAgencyRole,
  requireBusinessRole,
  type UserContext,
  type UserIdentity,
} from "@repo/db";
import type { EventSender } from "@repo/jobs";
import { loadSettings } from "@repo/settings/server";

import { requestWebsiteCrawl } from "../crawl/job";
import type { ImportMode, ProfileMode } from "../import/apply";
import type { ColumnMapping } from "../import/mapping";
import { type CsvImportResult, importCsv } from "../import/run";
import {
  confirmKnowledgeItem,
  createKnowledgeItem,
  deleteKnowledgeItem,
  type KnowledgeItemRecord,
  listKnowledgeItems,
  setKnowledgeItemStatus,
  updateKnowledgeItem,
} from "./items";

/**
 * Business knowledge for the admin panel (C15, C16): every method acts for a signed-in user.
 * Agency staff read and edit; client users of the business may read its facts (row-level
 * security allows that while client logins are on) and change nothing.
 */

export interface ImportRunRecord {
  readonly id: string;
  readonly businessId: BusinessId | null;
  readonly kind: ImportRunKind;
  readonly status: ImportRunStatus;
  /** The file's name, or the address of the website that was read. */
  readonly fileName: string | null;
  readonly stats: Readonly<Record<string, unknown>>;
  readonly problems: readonly unknown[];
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

export interface KnowledgeService {
  list(
    user: UserIdentity,
    businessId: BusinessId,
    options?: {
      readonly category?: KnowledgeCategory;
      readonly status?: KnowledgeItemStatus | "all";
    },
  ): Promise<KnowledgeItemRecord[]>;
  create(user: UserIdentity, businessId: BusinessId, item: unknown): Promise<KnowledgeItemRecord>;
  update(
    user: UserIdentity,
    businessId: BusinessId,
    id: string,
    patch: unknown,
  ): Promise<KnowledgeItemRecord>;
  archive(user: UserIdentity, businessId: BusinessId, id: string): Promise<KnowledgeItemRecord>;
  restore(user: UserIdentity, businessId: BusinessId, id: string): Promise<KnowledgeItemRecord>;
  /** "Still true": moves the fact's last-updated time. */
  confirm(user: UserIdentity, businessId: BusinessId, id: string): Promise<KnowledgeItemRecord>;
  remove(user: UserIdentity, businessId: BusinessId, id: string): Promise<void>;
  /** Imports an uploaded CSV file for one business. */
  importCsv(
    user: UserIdentity,
    input: {
      readonly businessId: BusinessId;
      readonly csv: string;
      readonly fileName?: string | null;
      readonly mapping?: ColumnMapping;
      readonly mode?: ImportMode;
      readonly profileMode?: ProfileMode;
    },
  ): Promise<CsvImportResult>;
  /** Imports a CSV file that names a business in every row (by its reference). */
  importAgencyCsv(
    user: UserIdentity,
    input: {
      readonly agencyId: AgencyId;
      readonly csv: string;
      readonly fileName?: string | null;
      readonly mapping?: ColumnMapping;
      readonly mode?: ImportMode;
      readonly profileMode?: ProfileMode;
    },
  ): Promise<CsvImportResult>;
  /** The latest imports of a business, newest first. */
  listImports(
    user: UserIdentity,
    businessId: BusinessId,
    limit?: number,
  ): Promise<ImportRunRecord[]>;
  /** Asks for the business's website to be read (when the setting allows it). */
  crawlWebsite(
    user: UserIdentity,
    businessId: BusinessId,
  ): Promise<{ readonly importRunId: string; readonly started: boolean }>;
}

interface Access {
  readonly tenant: BusinessTenant;
  readonly role: Role;
}

/** The business, as far as the user may see it, and the user's role toward it. */
async function businessAccess(ctx: UserContext, businessId: BusinessId): Promise<Access> {
  const [row] = await ctx.tx
    .select({ agencyId: businesses.agencyId, businessId: businesses.id })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  if (row === undefined) {
    throw new NotFoundError("Business not found.", { details: { businessId } });
  }
  const role = requireBusinessRole(await loadUserAccess(ctx), row);
  return { tenant: row, role };
}

async function staffAccess(ctx: UserContext, businessId: BusinessId): Promise<BusinessTenant> {
  const access = await businessAccess(ctx, businessId);
  if (!isAgencyRole(access.role)) {
    throw new TenantAccessError("Only agency staff can change a business's knowledge.", {
      details: { businessId },
    });
  }
  return access.tenant;
}

function toImportRun(row: typeof importRuns.$inferSelect): ImportRunRecord {
  return {
    id: row.id,
    businessId: row.businessId,
    kind: row.kind,
    status: row.status,
    fileName: row.fileName,
    stats: row.stats,
    problems: row.errors,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

export function createKnowledgeService(deps: {
  readonly db: Database;
  readonly events: EventSender;
  readonly logger: Logger;
  readonly clock?: () => Date;
}): KnowledgeService {
  const { db } = deps;
  const clock = deps.clock ?? (() => new Date());
  const asUser = <T>(user: UserIdentity, fn: (ctx: UserContext) => Promise<T>) =>
    db.asUser(user).run(fn);
  const asStaff = <T>(
    user: UserIdentity,
    businessId: BusinessId,
    fn: (ctx: UserContext, tenant: BusinessTenant) => Promise<T>,
  ) => asUser(user, async (ctx) => fn(ctx, await staffAccess(ctx, businessId)));

  return {
    list: (user, businessId, options = {}) =>
      asUser(user, async (ctx) => {
        const access = await businessAccess(ctx, businessId);
        // Only staff may read settings; a client user simply gets no "stale" flags.
        const staleAfterDays = isAgencyRole(access.role)
          ? (await loadSettings(ctx, access.tenant)).values["knowledge.stale_after_days"]
          : null;
        return listKnowledgeItems(ctx, businessId, { ...options, staleAfterDays, now: clock() });
      }),

    create: (user, businessId, item) =>
      asStaff(user, businessId, (ctx, tenant) => createKnowledgeItem(ctx, { tenant, item })),

    update: (user, businessId, id, patch) =>
      asStaff(user, businessId, (ctx, tenant) => updateKnowledgeItem(ctx, { tenant, id, patch })),

    archive: (user, businessId, id) =>
      asStaff(user, businessId, (ctx, tenant) =>
        setKnowledgeItemStatus(ctx, { tenant, id, status: "archived" }),
      ),

    restore: (user, businessId, id) =>
      asStaff(user, businessId, (ctx, tenant) =>
        setKnowledgeItemStatus(ctx, { tenant, id, status: "active" }),
      ),

    confirm: (user, businessId, id) =>
      asStaff(user, businessId, (ctx, tenant) => confirmKnowledgeItem(ctx, { tenant, id })),

    remove: (user, businessId, id) =>
      asStaff(user, businessId, (ctx, tenant) => deleteKnowledgeItem(ctx, { tenant, id })),

    importCsv: (user, input) =>
      asStaff(user, input.businessId, (ctx, tenant) =>
        importCsv(ctx, {
          agencyId: tenant.agencyId,
          businessId: tenant.businessId,
          csv: input.csv,
          fileName: input.fileName ?? null,
          ...(input.mapping === undefined ? {} : { mapping: input.mapping }),
          ...(input.mode === undefined ? {} : { mode: input.mode }),
          ...(input.profileMode === undefined ? {} : { profileMode: input.profileMode }),
          now: clock(),
        }),
      ),

    importAgencyCsv: (user, input) =>
      asUser(user, async (ctx) => {
        requireAgencyRole(await loadUserAccess(ctx), input.agencyId);
        return importCsv(ctx, {
          agencyId: input.agencyId,
          businessId: null,
          csv: input.csv,
          fileName: input.fileName ?? null,
          ...(input.mapping === undefined ? {} : { mapping: input.mapping }),
          ...(input.mode === undefined ? {} : { mode: input.mode }),
          ...(input.profileMode === undefined ? {} : { profileMode: input.profileMode }),
          now: clock(),
        });
      }),

    listImports: (user, businessId, limit = 20) =>
      asStaff(user, businessId, async (ctx, tenant) => {
        const rows = await ctx.tx
          .select()
          .from(importRuns)
          .where(eq(importRuns.businessId, tenant.businessId))
          .orderBy(desc(importRuns.createdAt), desc(importRuns.id))
          .limit(Math.min(Math.max(limit, 1), 100));
        return rows.map(toImportRun);
      }),

    async crawlWebsite(user, businessId) {
      const tenant = await asUser(user, (ctx) => staffAccess(ctx, businessId));
      return requestWebsiteCrawl(deps, { ...tenant, requestedBy: user.id });
    },
  };
}

/** Agency-wide imports (files with a reference column), newest first. For the agency's import screen. */
export async function listAgencyImports(
  db: Database,
  user: UserIdentity,
  agencyId: AgencyId,
  limit = 20,
): Promise<ImportRunRecord[]> {
  return db.asUser(user).run(async (ctx) => {
    requireAgencyRole(await loadUserAccess(ctx), agencyId);
    const rows = await ctx.tx
      .select()
      .from(importRuns)
      .where(and(eq(importRuns.agencyId, agencyId), isNull(importRuns.businessId)))
      .orderBy(desc(importRuns.createdAt), desc(importRuns.id))
      .limit(Math.min(Math.max(limit, 1), 100));
    return rows.map(toImportRun);
  });
}
