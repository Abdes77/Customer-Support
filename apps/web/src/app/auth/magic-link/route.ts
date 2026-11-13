import { authFlowContext } from "@/server/auth";
import { requestMagicLink } from "@/server/auth/flows";

export const dynamic = "force-dynamic";

/** Asks for a sign-in link by email. Posted by the form on /sign-in. */
export async function POST(request: Request): Promise<Response> {
  return requestMagicLink(request, await authFlowContext());
}
