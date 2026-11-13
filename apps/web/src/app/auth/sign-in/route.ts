import { authFlowContext } from "@/server/auth";
import { passwordSignIn } from "@/server/auth/flows";

export const dynamic = "force-dynamic";

/** Email and password sign-in. Posted by the form on /sign-in. */
export async function POST(request: Request): Promise<Response> {
  return passwordSignIn(request, await authFlowContext());
}
