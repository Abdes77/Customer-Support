import { createLocalObjectStoreFromEnv, serveLocalObject } from "@repo/db/storage";

export const dynamic = "force-dynamic";

/**
 * Serves files of the local object store (development and CI) for the signed URLs that
 * `TenantStorage.signedUrl` hands out. With Supabase Storage configured, or on any hosted
 * deployment, this route does not exist: it answers 404.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const store = createLocalObjectStoreFromEnv();
  if (store === null) return new Response("Not found", { status: 404 });
  const { path } = await params;
  return serveLocalObject(store, path.join("/"), new URL(request.url).searchParams);
}
