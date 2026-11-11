/**
 * Authentication for the web app (owner: C1). Server only.
 *
 *   const { user, access } = await requireAccess();          // in a page or server action
 *   requireBusinessRole(access, { businessId, agencyId });   // may this user act here?
 *   await userDatabase(user).run(({ tx }) => ...);           // row-level security decides
 *
 * Writes that users may not make directly (pipeline tables, credentials) go through the
 * owning package's server function, which checks the role and then uses the system scope.
 */
export { type AuthMode, resolveAuthMode } from "./mode";
export { createAuthProvider } from "./provider";
export { safeNextPath, signInUrl } from "./redirects";
export {
  authFlowContext,
  getAccess,
  getSessionUser,
  requireAccess,
  requireUser,
  type SessionAccess,
  userDatabase,
} from "./session";
export type { AuthProvider, SessionUser } from "./types";
export { requireAgencyRole, requireBusinessRole, type UserAccess } from "@repo/db";
