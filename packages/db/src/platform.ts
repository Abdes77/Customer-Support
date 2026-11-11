import { eq } from "drizzle-orm";

import { type AgencyId, ValidationError } from "@repo/core";

import { isUniqueViolation } from "./errors";
import type { Connection } from "./internal/client";
import { agencies } from "./schema/tables";

/*
 * CROSS-TENANT CODE (see directory.ts). Actions of the platform operator that exist above
 * any tenant. They are reachable from scripts and the seed only; no route may call them for
 * a signed-in user.
 */

export interface Platform {
  /** Creates an agency. Everything below it is then written through `forAgency()`. */
  createAgency(input: {
    readonly id?: AgencyId;
    readonly name: string;
    readonly slug: string;
  }): Promise<{ readonly id: AgencyId }>;

  /** Deletes an agency and, by cascade, every row that belongs to it. */
  deleteAgency(agencyId: AgencyId): Promise<void>;

  /** Looks an agency up by its slug. */
  findAgencyBySlug(slug: string): Promise<{ readonly id: AgencyId; readonly name: string } | null>;
}

export function createPlatform(connection: Connection): Platform {
  const { db } = connection;
  return {
    async createAgency(input) {
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.slug)) {
        throw new ValidationError(
          "An agency slug is lower-case letters, digits and hyphens, at most 63 characters.",
        );
      }
      try {
        const rows = await db
          .insert(agencies)
          .values({ id: input.id, name: input.name, slug: input.slug })
          .returning({ id: agencies.id });
        const row = rows[0];
        if (row === undefined) throw new Error("The agency insert returned no row.");
        return row;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ValidationError("An agency with this slug or id already exists.", {
            cause: error,
          });
        }
        throw error;
      }
    },

    async deleteAgency(agencyId) {
      await db.delete(agencies).where(eq(agencies.id, agencyId));
    },

    async findAgencyBySlug(slug) {
      const rows = await db
        .select({ id: agencies.id, name: agencies.name })
        .from(agencies)
        .where(eq(agencies.slug, slug))
        .limit(1);
      return rows[0] ?? null;
    },
  };
}
