import { z } from "zod";

import { type AgencyId, BusinessId, NotFoundError, type UserId, ValidationError } from "@repo/core";
import {
  and,
  apiKeys,
  businesses,
  type Database,
  desc,
  eq,
  generateApiKey,
  isNull,
  loadUserAccess,
  recordSystemAudit,
  recordUserAudit,
  requireAgencyRole,
  type UserIdentity,
} from "@repo/db";

import { IMPORT_SCOPE_READ, IMPORT_SCOPE_WRITE } from "./http";

/**
 * Keys for the import API. An agency admin creates a key for the whole agency or for one
 * business; the key itself is shown once and only its hash is stored (C1). Revoking a key
 * stops it at the next request.
 */

export const API_KEY_SCOPES = [IMPORT_SCOPE_WRITE, IMPORT_SCOPE_READ] as const;

export const CreateApiKeyInput = z.strictObject({
  name: z.string().trim().min(1).max(120),
  /** Limits the key to one business. Null or absent: every business of the agency. */
  businessId: BusinessId.nullable().optional(),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).default([IMPORT_SCOPE_WRITE]),
  /** ISO 8601. Null or absent: the key does not expire. */
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
});
export type CreateApiKeyInput = z.input<typeof CreateApiKeyInput>;

export interface ApiKeyRecord {
  readonly id: string;
  readonly name: string;
  /** `hsrb_<8 hex>`: enough to tell keys apart, useless as a credential. */
  readonly prefix: string;
  readonly businessId: BusinessId | null;
  readonly scopes: readonly string[];
  readonly createdBy: UserId | null;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
}

export interface CreatedApiKey extends ApiKeyRecord {
  /** The key itself. Shown once: it cannot be recovered. */
  readonly key: string;
}

type Row = typeof apiKeys.$inferSelect;

function toRecord(row: Row): ApiKeyRecord {
  return {
    id: row.id,
    name: row.name,
    prefix: row.keyPrefix,
    businessId: row.businessId,
    scopes: row.scopes,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

function parseInput(input: unknown) {
  const parsed = CreateApiKeyInput.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "key"}: ${issue.message}`)
        .join("; "),
    );
  }
  return parsed.data;
}

export interface ApiKeyService {
  /** Agency admins only. */
  create(user: UserIdentity, agencyId: AgencyId, input: CreateApiKeyInput): Promise<CreatedApiKey>;
  list(user: UserIdentity, agencyId: AgencyId): Promise<ApiKeyRecord[]>;
  revoke(user: UserIdentity, agencyId: AgencyId, keyId: string): Promise<ApiKeyRecord>;
}

export function createApiKeyService(deps: {
  readonly db: Database;
  readonly clock?: () => Date;
}): ApiKeyService {
  const { db } = deps;
  const clock = deps.clock ?? (() => new Date());
  return {
    create: (user, agencyId, input) =>
      db.asUser(user).run(async (ctx) => {
        requireAgencyRole(await loadUserAccess(ctx), agencyId, ["agency_admin"]);
        const data = parseInput(input);
        const businessId = data.businessId ?? null;
        if (businessId !== null) {
          const [business] = await ctx.tx
            .select({ id: businesses.id })
            .from(businesses)
            .where(and(eq(businesses.id, businessId), eq(businesses.agencyId, agencyId)))
            .limit(1);
          if (business === undefined) {
            throw new NotFoundError("Business not found.", { details: { businessId } });
          }
        }
        const generated = generateApiKey();
        const [row] = await ctx.tx
          .insert(apiKeys)
          .values({
            agencyId,
            businessId,
            name: data.name,
            keyPrefix: generated.prefix,
            keyHash: generated.hash,
            scopes: [...data.scopes],
            createdBy: user.id,
            expiresAt: data.expiresAt == null ? null : new Date(data.expiresAt),
          })
          .returning();
        if (row === undefined) throw new Error("Insert into api_keys returned no row");
        await recordUserAudit(
          ctx,
          { agencyId, businessId },
          {
            action: "api_key.create",
            targetType: "api_key",
            targetId: row.id,
            summary: `API key created: ${row.name} (${row.keyPrefix})`,
            metadata: { scopes: row.scopes },
          },
        );
        return { ...toRecord(row), key: generated.key };
      }),

    list: (user, agencyId) =>
      db.asUser(user).run(async (ctx) => {
        requireAgencyRole(await loadUserAccess(ctx), agencyId, ["agency_admin"]);
        const rows = await ctx.tx
          .select()
          .from(apiKeys)
          .where(eq(apiKeys.agencyId, agencyId))
          .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));
        return rows.map(toRecord);
      }),

    revoke: (user, agencyId, keyId) =>
      db.asUser(user).run(async (ctx) => {
        requireAgencyRole(await loadUserAccess(ctx), agencyId, ["agency_admin"]);
        const [row] = await ctx.tx
          .update(apiKeys)
          .set({ revokedAt: clock() })
          .where(
            and(eq(apiKeys.id, keyId), eq(apiKeys.agencyId, agencyId), isNull(apiKeys.revokedAt)),
          )
          .returning();
        if (row === undefined) {
          const [existing] = await ctx.tx
            .select()
            .from(apiKeys)
            .where(and(eq(apiKeys.id, keyId), eq(apiKeys.agencyId, agencyId)))
            .limit(1);
          if (existing === undefined) {
            throw new NotFoundError("API key not found.", { details: { keyId } });
          }
          return toRecord(existing);
        }
        await recordUserAudit(
          ctx,
          { agencyId, businessId: row.businessId },
          {
            action: "api_key.revoke",
            targetType: "api_key",
            targetId: row.id,
            summary: `API key revoked: ${row.name} (${row.keyPrefix})`,
          },
        );
        return toRecord(row);
      }),
  };
}

/**
 * Creates a key from a script (`pnpm --filter @repo/knowledge api-key`), where there is no
 * signed-in user: the platform operator setting up the first integration.
 */
export async function createApiKeyAsSystem(
  db: Database,
  input: {
    readonly agencyId: AgencyId;
    readonly name: string;
    readonly businessId?: BusinessId | null;
    readonly scopes?: readonly (typeof API_KEY_SCOPES)[number][];
  },
): Promise<CreatedApiKey> {
  const data = parseInput({
    name: input.name,
    businessId: input.businessId ?? null,
    ...(input.scopes === undefined ? {} : { scopes: [...input.scopes] }),
  });
  const generated = generateApiKey();
  return db.forAgency(input.agencyId).run(async (ctx) => {
    const [row] = await ctx.tx
      .insert(apiKeys)
      .values({
        agencyId: input.agencyId,
        businessId: data.businessId ?? null,
        name: data.name,
        keyPrefix: generated.prefix,
        keyHash: generated.hash,
        scopes: [...data.scopes],
      })
      .returning();
    if (row === undefined) throw new Error("Insert into api_keys returned no row");
    await recordSystemAudit(
      ctx,
      { type: "system", label: "api-key-script" },
      {
        action: "api_key.create",
        targetType: "api_key",
        targetId: row.id,
        summary: `API key created: ${row.name} (${row.keyPrefix})`,
        metadata: { scopes: row.scopes },
      },
    );
    return { ...toRecord(row), key: generated.key };
  });
}
