import { authFlowContext } from "@/server/auth";
import { signOut } from "@/server/auth/flows";

export const dynamic = "force-dynamic";

/** Ends the session. POST only, so a link or an image tag cannot sign anyone out. */
export async function POST(request: Request): Promise<Response> {
  return signOut(request, await authFlowContext());
}
