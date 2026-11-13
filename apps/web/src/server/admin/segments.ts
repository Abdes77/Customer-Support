import { SegmentId } from "@repo/core";
import { asc, eq, segments } from "@repo/db";

import { type SessionAccess, userDatabase } from "@/server/auth";

/** The segments the signed-in person may see (row-level security: staff of the agency). */
export async function listVisibleSegments(session: SessionAccess) {
  return userDatabase(session.user).run(({ tx }) =>
    tx
      .select({
        id: segments.id,
        agencyId: segments.agencyId,
        name: segments.name,
        slug: segments.slug,
      })
      .from(segments)
      .orderBy(asc(segments.name)),
  );
}

/** One segment by the id in a URL, or null. */
export async function findVisibleSegment(session: SessionAccess, segmentId: string) {
  const id = SegmentId.safeParse(segmentId);
  if (!id.success) return null;
  const [row] = await userDatabase(session.user).run(({ tx }) =>
    tx
      .select({
        id: segments.id,
        agencyId: segments.agencyId,
        name: segments.name,
        slug: segments.slug,
      })
      .from(segments)
      .where(eq(segments.id, id.data))
      .limit(1),
  );
  return row ?? null;
}
