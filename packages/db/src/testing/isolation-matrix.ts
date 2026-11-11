import { randomUUID } from "node:crypto";

import type { PgTable } from "drizzle-orm/pg-core";

import type { AgencyId, BusinessId, UserId } from "@repo/core";

import * as tables from "../schema/tables";

/**
 * The tenant-isolation matrix: one entry per table, saying how to build a valid row and who
 * may do what with it. `isolation.test.ts` reads the list of tables from the PostgreSQL
 * catalog and fails when a table with a `business_id` column is missing here, then tries
 * every operation as every role and as both system scopes.
 *
 * The expectations are written out again here on purpose, instead of being derived from the
 * policy builders in the schema: a mistake in a policy shows up as a disagreement.
 *
 * ADDING A TABLE (later chunks): add an entry below, after the tables it refers to.
 *   - `kind`: "business" (agency_id and business_id NOT NULL), "shared" (business_id may be
 *     null for agency-level rows) or "agency" (no business_id).
 *   - `row`: values for a new row, with Drizzle property names. Use `r.tenant` for the
 *     tenant columns, `r.ref("table")` for ids of rows that already exist in that tenant,
 *     and `r.unique()` for anything under a unique constraint.
 *   - `change`: a column and value that an UPDATE may set without breaking a constraint.
 *   - `user`: who may read and write as a signed-in user; `system`: what jobs may do.
 */

export type AccessLevel = "staff" | "admin" | "nobody";

export interface RowContext {
  /** Tenant columns to spread into the row. For "agency" tables only `agencyId` is set. */
  readonly tenant: { readonly agencyId: AgencyId; readonly businessId: BusinessId };
  /**
   * Why the row is built. "fixture": the row every tenant starts with. "spare": a second,
   * childless parent row for tables marked `spare`. "attempt": a row a test tries to insert.
   */
  readonly purpose: "fixture" | "spare" | "attempt";
  /**
   * Id of the row of `table` in this tenant. An attempt gets the spare row when the table
   * has one, so it does not collide with the children of the fixture row.
   */
  ref(table: string): string;
  /** The user performing the insert (the note author or audit actor must be this user). */
  readonly actor: UserId;
  /** A user of the tenant's agency that exists, for created_by-style columns. */
  readonly staffUserId: UserId;
  /** A user with no membership in this tenant, for membership tables. */
  readonly spareUserId: UserId;
  /** The tenant's segment. */
  readonly segmentId: string;
  /** A fresh value for a column under a unique constraint. */
  unique(prefix?: string): string;
  /** A fresh positive integer, for version and sequence columns. */
  uniqueInt(): number;
}

export interface MatrixActor {
  readonly id: UserId;
  /** Role in the row's agency, if the actor is staff there. */
  readonly agencyRole: "agency_admin" | "agency_member" | null;
}

export interface MatrixEntry {
  /** SQL table name. */
  readonly name: string;
  readonly table: PgTable;
  readonly kind: "business" | "shared" | "agency";
  /** SQL name of the primary key column. Default "id". */
  readonly pk?: string;
  /** Build a second, childless row per tenant that attempts can hang children on. */
  readonly spare?: boolean;
  /** The fixture rows come from the world (memberships), not from `row`. */
  readonly worldFixture?: boolean;
  row(r: RowContext): Record<string, unknown>;
  /** "shared" tables: an agency-level row (business_id null). */
  agencyRow?(r: RowContext): Record<string, unknown>;
  readonly change: { readonly column: string; readonly value: string | number | boolean };
  readonly user: {
    readonly read: AccessLevel;
    /** Client users of the row's business may read it. */
    readonly clientRead?: boolean;
    readonly insert?: AccessLevel;
    readonly update?: AccessLevel;
    readonly delete?: AccessLevel;
  };
  /**
   * Rules that are not a plain level: given the acting user and the id of the user who
   * wrote the fixture row, may the actor update or delete that row?
   */
  readonly userOverride?: {
    readonly update?: (actor: MatrixActor, fixtureAuthorId: UserId) => boolean;
    readonly delete?: (actor: MatrixActor, fixtureAuthorId: UserId) => boolean;
  };
  readonly system: "read_write" | "append_only" | "read_only";
  /** "shared" tables: a business scope also reads the agency-level rows. */
  readonly businessScopeReadsAgencyRows?: boolean;
}

const READ_ONLY_FOR_USERS = { read: "staff" } as const;
const CLIENT_READABLE = { read: "staff", clientRead: true } as const;
const STAFF_MANAGED = { read: "staff", insert: "staff", update: "staff", delete: "staff" } as const;
const STAFF_MANAGED_ADMIN_DELETE = {
  read: "staff",
  insert: "staff",
  update: "staff",
  delete: "admin",
} as const;
const ADMIN_MANAGED = { read: "admin", insert: "admin", update: "admin", delete: "admin" } as const;

const now = () => new Date();

const SAMPLE_PLAYBOOK = {
  commonJobs: [{ name: "Repair", scope: "Fix what is broken" }],
  customerLanguage: [{ phrase: "it's leaking", meaning: "active leak" }],
  urgencySignals: [{ signal: "water coming in", level: "emergency" as const }],
  qualificationQuestions: [{ question: "What is going on?", why: "Scope" }],
  objections: [{ objection: "Too expensive", response: "We can talk through options." }],
  seasonalPatterns: ["Busy after storms"],
  priceNorms: [{ job: "Repair", range: "$300 to $1,500", notes: null }],
  permitsAndRegulations: ["Permits vary by city"],
  vocabulary: [{ term: "flashing", definition: "Metal that seals roof joints" }],
  sources: [{ title: "Example source", url: "https://example.com/source" }],
};

/** In dependency order: a table comes after every table its rows refer to. */
export const ISOLATION_MATRIX: readonly MatrixEntry[] = [
  // --- agency-level tables -------------------------------------------------------------
  {
    name: "agency_memberships",
    table: tables.agencyMemberships,
    kind: "agency",
    worldFixture: true,
    row: (r) => ({ agencyId: r.tenant.agencyId, userId: r.spareUserId, role: "agency_member" }),
    change: { column: "role", value: "agency_member" },
    user: { read: "staff", insert: "admin", update: "admin", delete: "admin" },
    system: "read_write",
  },
  {
    name: "segments",
    table: tables.segments,
    kind: "agency",
    worldFixture: true,
    row: (r) => ({ agencyId: r.tenant.agencyId, slug: r.unique("segment"), name: "Segment" }),
    change: { column: "name", value: "Renamed segment" },
    user: STAFF_MANAGED_ADMIN_DELETE,
    system: "read_write",
  },
  {
    name: "playbook_versions",
    table: tables.playbookVersions,
    kind: "agency",
    row: (r) => ({
      agencyId: r.tenant.agencyId,
      segmentId: r.segmentId,
      version: r.uniqueInt(),
      isActive: r.purpose === "fixture",
      origin: "manual",
      document: SAMPLE_PLAYBOOK,
      createdBy: r.staffUserId,
    }),
    change: { column: "change_note", value: "Edited" },
    user: STAFF_MANAGED_ADMIN_DELETE,
    system: "read_write",
  },

  // --- tenancy ---------------------------------------------------------------------------
  {
    name: "business_memberships",
    table: tables.businessMemberships,
    kind: "business",
    worldFixture: true,
    row: (r) => ({ ...r.tenant, userId: r.spareUserId, role: "client_staff" }),
    change: { column: "role", value: "client_staff" },
    // Client users see their own membership (and an owner sees the team): "clientRead".
    user: { read: "staff", clientRead: true, insert: "admin", update: "admin", delete: "admin" },
    system: "read_write",
  },
  {
    name: "api_keys",
    table: tables.apiKeys,
    kind: "shared",
    row: (r) => ({
      ...r.tenant,
      name: "Import key",
      keyPrefix: r.unique("hsrb"),
      keyHash: r.unique("hash"),
      createdBy: r.staffUserId,
    }),
    agencyRow: (r) => ({
      agencyId: r.tenant.agencyId,
      businessId: null,
      name: "Agency-wide key",
      keyPrefix: r.unique("hsrb"),
      keyHash: r.unique("hash"),
    }),
    change: { column: "name", value: "Renamed key" },
    user: ADMIN_MANAGED,
    system: "read_write",
  },

  // --- knowledge and playbooks -------------------------------------------------------------
  {
    name: "import_runs",
    table: tables.importRuns,
    kind: "shared",
    row: (r) => ({ ...r.tenant, kind: "csv", status: "succeeded", createdBy: r.staffUserId }),
    agencyRow: (r) => ({ agencyId: r.tenant.agencyId, businessId: null, kind: "api" }),
    change: { column: "file_name", value: "leads.csv" },
    user: { read: "staff", insert: "staff", update: "staff" },
    system: "read_write",
  },
  {
    name: "knowledge_items",
    table: tables.knowledgeItems,
    kind: "business",
    row: (r) => ({
      ...r.tenant,
      category: "services",
      title: "Services",
      content: "Roof repair and replacement.",
      source: "manual",
      importRunId: r.ref("import_runs"),
    }),
    change: { column: "title", value: "What we do" },
    user: { ...STAFF_MANAGED, clientRead: true },
    system: "read_write",
  },
  {
    name: "business_playbook_overrides",
    table: tables.businessPlaybookOverrides,
    kind: "business",
    row: (r) => ({ ...r.tenant, section: r.unique("section"), content: [] }),
    change: { column: "base_version", value: 2 },
    user: STAFF_MANAGED,
    system: "read_write",
  },

  // --- settings ----------------------------------------------------------------------------
  {
    name: "setting_values",
    table: tables.settingValues,
    kind: "shared",
    row: (r) => ({
      agencyId: r.tenant.agencyId,
      businessId: r.tenant.businessId,
      scope: "business",
      key: r.unique("setting"),
      value: { enabled: true },
    }),
    agencyRow: (r) => ({
      agencyId: r.tenant.agencyId,
      scope: "global",
      key: r.unique("setting"),
      value: "global value",
    }),
    change: { column: "version", value: 2 },
    // Business-scope rows: any staff. (Global and segment rows need an admin: see the
    // dedicated settings tests.)
    user: STAFF_MANAGED,
    system: "read_write",
    businessScopeReadsAgencyRows: true,
  },
  {
    name: "setting_versions",
    table: tables.settingVersions,
    kind: "shared",
    row: (r) => ({
      agencyId: r.tenant.agencyId,
      businessId: r.tenant.businessId,
      scope: "business",
      key: r.unique("setting"),
      version: 1,
      operation: "set",
      value: { enabled: true },
      changedBy: r.actor,
    }),
    agencyRow: (r) => ({
      agencyId: r.tenant.agencyId,
      scope: "global",
      key: r.unique("setting"),
      version: 1,
      operation: "set",
      value: "global value",
      changedBy: r.actor,
    }),
    change: { column: "change_note", value: "Edited" },
    user: { read: "staff", insert: "staff" },
    system: "append_only",
    businessScopeReadsAgencyRows: true,
  },

  // --- channels ----------------------------------------------------------------------------
  {
    name: "channel_connections",
    table: tables.channelConnections,
    kind: "business",
    spare: true,
    row: (r) => ({
      ...r.tenant,
      channel: "test",
      externalAccountId: r.unique("account"),
      displayName: "Test channel",
      status: "active",
    }),
    change: { column: "display_name", value: "Renamed channel" },
    // Written by the connect flows only: the account id decides who receives the webhooks.
    user: READ_ONLY_FOR_USERS,
    system: "read_write",
  },
  {
    name: "channel_connection_secrets",
    table: tables.channelConnectionSecrets,
    kind: "business",
    pk: "connection_id",
    row: (r) => ({
      ...r.tenant,
      connectionId: r.ref("channel_connections"),
      ciphertext: "v1.test.AAAA.AAAA.AAAA",
      keyId: "test",
    }),
    change: { column: "key_id", value: "test2" },
    user: { read: "nobody" },
    system: "read_write",
  },
  {
    name: "message_templates",
    table: tables.messageTemplates,
    kind: "business",
    row: (r) => ({
      ...r.tenant,
      channelConnectionId: r.ref("channel_connections"),
      name: r.unique("template"),
    }),
    change: { column: "category", value: "UTILITY" },
    user: STAFF_MANAGED,
    system: "read_write",
  },

  // --- conversations -----------------------------------------------------------------------
  {
    name: "contacts",
    table: tables.contacts,
    kind: "business",
    row: (r) => ({ ...r.tenant, displayName: "Casey Customer", phone: "+15555550123" }),
    change: { column: "display_name", value: "Renamed" },
    user: CLIENT_READABLE,
    system: "read_write",
  },
  {
    name: "contact_identities",
    table: tables.contactIdentities,
    kind: "business",
    row: (r) => ({
      ...r.tenant,
      contactId: r.ref("contacts"),
      channel: "test",
      externalId: r.unique("visitor"),
    }),
    change: { column: "display_name", value: "Renamed" },
    user: CLIENT_READABLE,
    system: "read_write",
  },
  {
    name: "conversations",
    table: tables.conversations,
    kind: "business",
    spare: true,
    row: (r) => ({
      ...r.tenant,
      contactId: r.ref("contacts"),
      channelConnectionId: r.ref("channel_connections"),
      channel: "test",
      externalThreadId: r.unique("thread"),
    }),
    change: { column: "subject", value: "Changed subject" },
    user: CLIENT_READABLE,
    system: "read_write",
  },
  {
    name: "messages",
    table: tables.messages,
    kind: "business",
    row: (r) => ({
      ...r.tenant,
      conversationId: r.ref("conversations"),
      channelConnectionId: r.ref("channel_connections"),
      direction: "inbound",
      author: "customer",
      text: "My roof is leaking",
      externalMessageId: r.unique("message"),
      sequence: r.uniqueInt(),
      status: "received",
    }),
    change: { column: "error_code", value: "changed" },
    user: CLIENT_READABLE,
    system: "read_write",
  },
  {
    name: "attachments",
    table: tables.attachments,
    kind: "business",
    row: (r) => ({ ...r.tenant, messageId: r.ref("messages"), kind: "image" }),
    change: { column: "file_name", value: "roof.jpg" },
    user: CLIENT_READABLE,
    system: "read_write",
  },
  {
    name: "takeover_locks",
    table: tables.takeoverLocks,
    kind: "business",
    row: (r) => ({
      ...r.tenant,
      conversationId: r.ref("conversations"),
      userId: r.staffUserId,
      source: "admin_panel",
    }),
    change: { column: "reason", value: "Customer asked for a person" },
    user: CLIENT_READABLE,
    system: "read_write",
  },
  {
    name: "internal_notes",
    table: tables.internalNotes,
    kind: "business",
    row: (r) => ({
      ...r.tenant,
      conversationId: r.ref("conversations"),
      authorUserId: r.actor,
      body: "Called back, no answer.",
    }),
    change: { column: "body", value: "Edited note" },
    user: { read: "staff", insert: "staff", update: "staff", delete: "staff" },
    userOverride: {
      // Staff change only their own notes; an admin may also delete anyone's.
      update: (actor, author) => actor.agencyRole !== null && actor.id === author,
      delete: (actor, author) =>
        actor.agencyRole === "agency_admin" || (actor.agencyRole !== null && actor.id === author),
    },
    system: "read_write",
  },
  {
    name: "widget_sessions",
    table: tables.widgetSessions,
    kind: "business",
    row: (r) => ({
      ...r.tenant,
      channelConnectionId: r.ref("channel_connections"),
      visitorId: r.unique("visitor"),
      contactId: r.ref("contacts"),
      conversationId: r.ref("conversations"),
    }),
    change: { column: "origin", value: "https://example.com" },
    user: READ_ONLY_FOR_USERS,
    system: "read_write",
  },

  // --- leads -------------------------------------------------------------------------------
  {
    name: "leads",
    table: tables.leads,
    kind: "business",
    row: (r) => ({
      ...r.tenant,
      contactId: r.ref("contacts"),
      conversationId: r.ref("conversations"),
      status: "qualifying",
      score: 40,
    }),
    change: { column: "band", value: "warm" },
    user: CLIENT_READABLE,
    system: "read_write",
  },
  {
    name: "lead_fields",
    table: tables.leadFields,
    kind: "business",
    row: (r) => ({
      ...r.tenant,
      leadId: r.ref("leads"),
      key: r.unique("criterion"),
      value: "this_month",
      confidence: 0.8,
    }),
    change: { column: "evidence", value: "Said so" },
    user: CLIENT_READABLE,
    system: "read_write",
  },
  {
    name: "lead_reports",
    table: tables.leadReports,
    kind: "business",
    row: (r) => ({
      ...r.tenant,
      leadId: r.ref("leads"),
      version: r.uniqueInt(),
      summary: "Leak over the kitchen",
      markdown: "## Lead\nLeak over the kitchen.",
    }),
    change: { column: "band", value: "warm" },
    user: CLIENT_READABLE,
    system: "read_write",
  },
  {
    name: "routing_decisions",
    table: tables.routingDecisions,
    kind: "business",
    row: (r) => ({
      ...r.tenant,
      leadId: r.ref("leads"),
      outcome: "contact_later",
      score: 40,
      band: "warm",
      reasons: ["Timeline known"],
      settingsVersion: "test",
      decidedAt: now(),
    }),
    change: { column: "band", value: "hot" },
    user: CLIENT_READABLE,
    system: "read_write",
  },

  // --- model -------------------------------------------------------------------------------
  {
    name: "model_calls",
    table: tables.modelCalls,
    kind: "business",
    row: (r) => ({
      ...r.tenant,
      conversationId: r.ref("conversations"),
      traceId: randomUUID(),
      purpose: "reply",
      model: "claude-fable-5-2",
      effort: "high",
      promptVersion: "test",
      startedAt: now(),
      latencyMs: 1200,
      request: { system: "prompt" },
      response: { text: "reply" },
    }),
    change: { column: "stop_reason", value: "end_turn" },
    user: READ_ONLY_FOR_USERS,
    system: "read_write",
  },
  {
    name: "conversation_turns",
    table: tables.conversationTurns,
    kind: "business",
    row: (r) => ({
      ...r.tenant,
      conversationId: r.ref("conversations"),
      ordinal: r.uniqueInt(),
      trigger: "inbound_message",
      status: "replied",
      runId: r.unique("run"),
      traceId: randomUUID(),
      throughSeq: 1,
    }),
    change: { column: "skip_reason", value: "changed" },
    user: READ_ONLY_FOR_USERS,
    system: "read_write",
  },

  // --- integrations ------------------------------------------------------------------------
  {
    name: "integration_connections",
    table: tables.integrationConnections,
    kind: "business",
    spare: true,
    row: (r) => ({ ...r.tenant, provider: "webhook", displayName: "Webhook", status: "active" }),
    change: { column: "display_name", value: "Renamed" },
    user: READ_ONLY_FOR_USERS,
    system: "read_write",
  },
  {
    name: "integration_connection_secrets",
    table: tables.integrationConnectionSecrets,
    kind: "business",
    pk: "connection_id",
    row: (r) => ({
      ...r.tenant,
      connectionId: r.ref("integration_connections"),
      ciphertext: "v1.test.AAAA.AAAA.AAAA",
      keyId: "test",
    }),
    change: { column: "key_id", value: "test2" },
    user: { read: "nobody" },
    system: "read_write",
  },
  {
    name: "integration_events",
    table: tables.integrationEvents,
    kind: "business",
    row: (r) => ({
      ...r.tenant,
      integrationConnectionId: r.ref("integration_connections"),
      leadId: r.ref("leads"),
      eventType: "push_lead",
      idempotencyKey: r.unique("event"),
    }),
    change: { column: "error_code", value: "changed" },
    user: READ_ONLY_FOR_USERS,
    system: "read_write",
  },
  {
    name: "bookings",
    table: tables.bookings,
    kind: "business",
    row: (r) => ({
      ...r.tenant,
      contactId: r.ref("contacts"),
      conversationId: r.ref("conversations"),
      leadId: r.ref("leads"),
      integrationConnectionId: r.ref("integration_connections"),
      provider: "manual",
      externalEventId: r.unique("event"),
    }),
    change: { column: "title", value: "Roof inspection" },
    user: CLIENT_READABLE,
    system: "read_write",
  },

  // --- operations --------------------------------------------------------------------------
  {
    name: "scheduled_jobs",
    table: tables.scheduledJobs,
    kind: "business",
    row: (r) => ({
      ...r.tenant,
      conversationId: r.ref("conversations"),
      leadId: r.ref("leads"),
      kind: "follow_up",
      runAt: now(),
      dedupeKey: r.unique("job"),
    }),
    change: { column: "last_error", value: "changed" },
    user: READ_ONLY_FOR_USERS,
    system: "read_write",
  },
  {
    name: "alerts",
    table: tables.alerts,
    kind: "business",
    row: (r) => ({
      ...r.tenant,
      conversationId: r.ref("conversations"),
      leadId: r.ref("leads"),
      kind: "lead_qualified",
      channel: "email",
      recipient: "owner@example.com",
      dedupeKey: r.unique("alert"),
    }),
    change: { column: "subject", value: "New lead" },
    user: READ_ONLY_FOR_USERS,
    system: "read_write",
  },
  {
    name: "escalations",
    table: tables.escalations,
    kind: "business",
    row: (r) => ({
      ...r.tenant,
      conversationId: r.ref("conversations"),
      leadId: r.ref("leads"),
      emergencyClass: "gas_leak",
    }),
    change: { column: "summary", value: "Smell of gas" },
    user: READ_ONLY_FOR_USERS,
    system: "read_write",
  },
  {
    name: "dead_letters",
    table: tables.deadLetters,
    kind: "shared",
    row: (r) => ({ ...r.tenant, source: "pipeline-reply", errorMessage: "Gave up" }),
    agencyRow: (r) => ({
      agencyId: r.tenant.agencyId,
      businessId: null,
      source: "knowledge-import",
      errorMessage: "Gave up",
    }),
    change: { column: "error_code", value: "changed" },
    user: READ_ONLY_FOR_USERS,
    system: "read_write",
  },
  {
    name: "usage_counters",
    table: tables.usageCounters,
    kind: "business",
    row: (r) => ({
      ...r.tenant,
      metric: r.unique("metric"),
      windowStart: now(),
      windowSeconds: 3600,
      value: 1,
    }),
    change: { column: "value", value: 2 },
    user: READ_ONLY_FOR_USERS,
    system: "read_write",
  },
  {
    name: "audit_log",
    table: tables.auditLog,
    kind: "shared",
    row: (r) => ({
      ...r.tenant,
      actorType: "user",
      actorUserId: r.actor,
      action: "test.action",
    }),
    agencyRow: (r) => ({
      agencyId: r.tenant.agencyId,
      businessId: null,
      actorType: "user",
      actorUserId: r.actor,
      action: "test.agency_action",
    }),
    change: { column: "summary", value: "Rewritten history" },
    // Staff add entries under their own name; only admins read; nobody changes or deletes.
    user: { read: "admin", insert: "staff" },
    system: "append_only",
  },
];

/**
 * Tables without a `business_id` column that are not in the matrix because their rules are
 * not "one row per tenant". Each has its own tests in `isolation.test.ts`.
 */
export const TABLES_WITH_DEDICATED_TESTS = ["agencies", "users", "businesses"] as const;
