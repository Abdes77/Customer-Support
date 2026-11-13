import { getAccess } from "@/server/auth";
import { exportLeadsCsv } from "@/server/leads";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * `GET /api/leads/export`: the lead list as CSV (C16), with the list's filters, for the
 * businesses whose leads the person may export (agency staff; a client user when the
 * business's `client_portal.export_leads` allows). Cells a spreadsheet would run as formulas
 * are neutralized; every download is audited.
 */
export async function GET(request: Request): Promise<Response> {
  const session = await getAccess();
  const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
  if (session === null) return new Response("Sign in first.", { status: 401, headers });
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const result = await exportLeadsCsv(session, params);
  if (result === null) return new Response("Not found", { status: 404, headers });
  const day = new Date().toISOString().slice(0, 10);
  return new Response(result.csv, {
    status: 200,
    headers: {
      ...headers,
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="leads-${day}.csv"`,
    },
  });
}
