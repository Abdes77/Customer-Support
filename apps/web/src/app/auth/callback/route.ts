import { authFlowContext } from "@/server/auth";
import { completeCodeSignIn } from "@/server/auth/flows";

export const dynamic = "force-dynamic";

/** Where a Supabase sign-in email leads: exchanges `?code=` for a session. */
export async function GET(request: Request): Promise<Response> {
  return completeCodeSignIn(request, await authFlowContext());
}
