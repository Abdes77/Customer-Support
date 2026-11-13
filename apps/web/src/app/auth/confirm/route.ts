import { authFlowContext } from "@/server/auth";
import { completeTokenSignIn } from "@/server/auth/flows";

export const dynamic = "force-dynamic";

/**
 * Where a sign-in link built from a token hash leads (`?token_hash=&type=`): the local
 * provider's links, and Supabase email templates that use `{{ .TokenHash }}`.
 */
export async function GET(request: Request): Promise<Response> {
  return completeTokenSignIn(request, await authFlowContext());
}
