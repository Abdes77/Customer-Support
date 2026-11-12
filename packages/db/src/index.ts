/**
 * @repo/db (owner: C1)
 *
 * The data layer: Drizzle schema and migrations, row-level security, the three access paths
 * (user context, system context, audited cross-tenant lookups), credential encryption and
 * the seed. docs/ARCHITECTURE.md §3 and §8 describe the model; `database.ts` is the entry.
 *
 * Server only. There is no export of an unrestricted client: go through `getDatabase()`.
 */

// Access paths
export {
  closeDatabase,
  createDatabase,
  type Database,
  type DatabaseOptions,
  getDatabase,
} from "./database";
export type {
  AgencyContext,
  AgencyScope,
  AgencyTenant,
  BusinessContext,
  BusinessScope,
  BusinessTenant,
  DbContext,
  RunOptions,
  SystemContext,
  UserContext,
  UserIdentity,
  UserScope,
} from "./context";
export type { Transaction } from "./internal/client";
export type {
  AlertRef,
  ApiKeyRef,
  BusinessRef,
  ChannelConnectionRef,
  IntegrationConnectionRef,
  Directory,
  TenantRef,
} from "./directory";
export type { Platform } from "./platform";
export type { LocalAuthStore, LocalAuthUser } from "./local-auth";

// Schema: tables, vocabularies and the policy builders for tables added by later chunks
export * from "./schema";
export {
  agencyPolicies,
  businessPolicies,
  type PolicyOptions,
  sharedPolicies,
  systemPolicies,
  userPolicies,
} from "./schema/policies";
export { createdAt, oneOf, tenantColumns, timestamptz, updatedAt } from "./schema/columns";

// Memberships and roles
export {
  type AgencyAccess,
  type AgencyRole,
  agencyRoleOf,
  type BusinessAccess,
  businessRoleOf,
  type ClientRole,
  hasAnyAccess,
  loadUserAccess,
  requireAgencyRole,
  requireBusinessRole,
  type UserAccess,
} from "./access";

// Credentials and keys
export {
  createKeyring,
  decryptJson,
  decryptSecret,
  encryptJson,
  encryptSecret,
  type KeyInput,
  type Keyring,
  keyringFromEnv,
  maskSecret,
  needsReencryption,
  parseRetiredKeys,
  type SecretBinding,
  SecretDecryptionError,
  secretKeyId,
} from "./crypto/secrets";
export type { AgencySecretStore, SecretStore, SecretStores } from "./repositories/secrets";
export { generateApiKey, type GeneratedApiKey, hashApiKey, looksLikeApiKey } from "./api-keys";

// Audit log
export {
  type AuditActor,
  type AuditEntry,
  recordSystemAudit,
  recordUserAudit,
} from "./repositories/audit";

// Errors
export {
  isAccessDenied,
  isForeignKeyViolation,
  isUniqueViolation,
  PG_ERROR,
  pgConstraintName,
  pgErrorCode,
} from "./errors";

// Query building. Import these from here so every package uses one copy of Drizzle.
export {
  and,
  asc,
  avg,
  between,
  count,
  countDistinct,
  desc,
  eq,
  exists,
  gt,
  gte,
  ilike,
  inArray,
  type InferInsertModel,
  type InferSelectModel,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  max,
  min,
  ne,
  not,
  notExists,
  notInArray,
  or,
  type SQL,
  sql,
  sum,
} from "drizzle-orm";
