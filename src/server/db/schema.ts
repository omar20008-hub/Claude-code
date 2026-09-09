import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  integer,
  bigint,
  boolean,
  jsonb,
  numeric,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from 'drizzle-orm/pg-core';
import { sql, relations } from 'drizzle-orm';

/* -------------------------------------------------------------------------- */
/* Conventions                                                                */
/*                                                                            */
/* - Every tenant-owned table carries a NOT NULL `organizationId` FK. That     */
/*   column is the isolation boundary; it is enforced three ways:              */
/*     1. Postgres row-level security (see drizzle/0001_rls.sql), which is the */
/*        backstop even for a query that forgets its WHERE clause.             */
/*     2. The tenant-scoped repository in src/server/tenancy, which is the     */
/*        only sanctioned way application code reaches these tables.           */
/*     3. Composite indexes leading with organizationId, so the scoped query   */
/*        is also the fast query.                                              */
/* - Soft deletion via `deletedAt` on user-visible content (assets,            */
/*   conversations, campaigns). Audit logs and usage records are never soft-   */
/*   deleted; they are append-only.                                            */
/* - Money is stored in minor units as bigint. Meta's Graph API uses minor     */
/*   units too, so there is no rounding step at the boundary.                  */
/* -------------------------------------------------------------------------- */

const now = sql`now()`;

/* ------------------------------- enums ----------------------------------- */

export const localeEnum = pgEnum('locale', ['ar', 'en']);

/**
 * Roles. The first release ships ADMIN only (§10), but the column is an enum
 * with the future values already declared so adding MANAGER/EMPLOYEE later is
 * a permission-table change, not a migration of every row.
 */
export const roleEnum = pgEnum('role', [
  'OWNER',
  'ADMIN',
  'MANAGER',
  'EMPLOYEE',
  'MARKETING_MANAGER',
]);

export const userStatusEnum = pgEnum('user_status', [
  'PENDING_VERIFICATION',
  'ACTIVE',
  'SUSPENDED',
]);

export const agentEnum = pgEnum('agent', [
  'KNOWLEDGE_AGENT',
  'CREATIVE_AGENT',
  'ADVERTISING_AGENT',
]);

export const jobStatusEnum = pgEnum('job_status', [
  'QUEUED',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);

export const assetKindEnum = pgEnum('asset_kind', ['IMAGE', 'VIDEO']);

export const assetStatusEnum = pgEnum('asset_status', [
  'PENDING',
  'STORED',
  'FAILED',
]);

export const campaignStatusEnum = pgEnum('campaign_status', [
  'DRAFT',
  'READY',
  'LAUNCHING',
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'FAILED',
]);

export const messageRoleEnum = pgEnum('message_role', [
  'USER',
  'ASSISTANT',
  'SYSTEM',
]);

export const integrationKindEnum = pgEnum('integration_kind', [
  'GOOGLE_DRIVE',
  'META_ADS',
  'N8N',
]);

export const integrationStatusEnum = pgEnum('integration_status', [
  'NOT_CONFIGURED',
  'CONNECTED',
  'DEGRADED',
  'ERROR',
]);

export const syncStatusEnum = pgEnum('sync_status', [
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
]);

export const notificationKindEnum = pgEnum('notification_kind', [
  'ASSET_READY',
  'ASSET_FAILED',
  'CAMPAIGN_SUBMITTED',
  'CAMPAIGN_FAILED',
  'KNOWLEDGE_SYNC_FAILED',
  'KNOWLEDGE_SYNC_SUCCEEDED',
  'AGENT_ERROR',
]);

export const usageMetricEnum = pgEnum('usage_metric', [
  'AGENT_REQUEST',
  'KNOWLEDGE_QUERY',
  'IMAGE_GENERATED',
  'VIDEO_GENERATED',
  'CAMPAIGN_CREATED',
  'CAMPAIGN_LAUNCH_SUBMITTED',
  'STORAGE_BYTES',
]);

export const tokenPurposeEnum = pgEnum('token_purpose', [
  'EMAIL_VERIFICATION',
  'PASSWORD_RESET',
]);

/* ---------------------------- organizations ------------------------------ */

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** URL-safe tenant handle. Unique across the platform. */
    slug: text('slug').notNull(),
    /** Organization-wide fallback when a user has expressed no preference. */
    defaultLocale: localeEnum('default_locale').notNull().default('ar'),
    /** IANA zone used to render dates and to bound Meta scheduling. */
    timezone: text('timezone').notNull().default('Asia/Riyadh'),
    /** ISO-4217. Reporting currency for ad spend. */
    currency: text('currency').notNull().default('SAR'),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('organizations_slug_key').on(t.slug)],
);

/* -------------------------------- users ---------------------------------- */

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Stored lowercased; uniqueness is per-platform, not per-tenant, so that
     *  login needs no tenant hint. */
    email: text('email').notNull(),
    /** scrypt-N16384-r8-p1 encoded string. Never leaves the server. */
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    role: roleEnum('role').notNull().default('ADMIN'),
    status: userStatusEnum('status').notNull().default('PENDING_VERIFICATION'),
    /** null until the user picks one; falls back to org default, then browser. */
    localePreference: localeEnum('locale_preference'),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    /** Brute-force controls. Reset on any successful authentication. */
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('users_email_key').on(sql`lower(${t.email})`),
    index('users_org_idx').on(t.organizationId, t.createdAt),
  ],
);

/* ------------------------------- sessions -------------------------------- */

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /**
     * SHA-256 of the opaque session token. The token itself only ever exists in
     * the user's cookie; a database leak therefore does not yield usable
     * sessions.
     */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Sliding-window renewal marker. */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().default(now),
    /** Truncated for privacy; used to show "active sessions" and spot theft. */
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_key').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId, t.expiresAt),
  ],
);

/* ------------------------- single-use auth tokens ------------------------- */

export const authTokens = pgTable(
  'auth_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: tokenPurposeEnum('purpose').notNull(),
    /** SHA-256 of the emailed token. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set on redemption; a second redemption is rejected. */
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (t) => [
    uniqueIndex('auth_tokens_hash_key').on(t.tokenHash),
    index('auth_tokens_user_purpose_idx').on(t.userId, t.purpose),
  ],
);

/* ------------------------------ rate limits ------------------------------ */

/**
 * Postgres-backed fixed-window rate limiter. Used when REDIS_URL is unset so a
 * single-instance deployment still gets real limiting rather than none.
 */
export const rateLimits = pgTable(
  'rate_limits',
  {
    /** `<bucket>:<subject>`, e.g. `login:ip:203.0.113.4`. */
    key: text('key').primaryKey(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('rate_limits_expiry_idx').on(t.expiresAt)],
);

/* ----------------------------- integrations ------------------------------ */

export const integrations = pgTable(
  'integrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    kind: integrationKindEnum('kind').notNull(),
    status: integrationStatusEnum('status').notNull().default('NOT_CONFIGURED'),
    /**
     * Non-secret display data only: account ids, folder names, page names.
     * Anything the browser may see.
     */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    /**
     * AES-256-GCM ciphertext of credentials, when the SaaS holds any. For the
     * current n8n-owned Google Drive and Meta credentials this stays null —
     * see docs/n8n-integration.md, "credential ownership".
     */
    encryptedCredentials: text('encrypted_credentials'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
  },
  (t) => [
    uniqueIndex('integrations_org_kind_key').on(t.organizationId, t.kind),
    index('integrations_org_idx').on(t.organizationId),
  ],
);

/* ---------------------------- conversations ------------------------------ */

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    agent: agentEnum('agent').notNull(),
    title: text('title').notNull(),
    /**
     * The sessionId handed to the n8n chat trigger. All three workflows keep a
     * 10-turn buffer memory keyed on this value, so it must be stable for the
     * life of the conversation and unguessable (it is effectively a capability
     * for that memory).
     */
    agentSessionId: text('agent_session_id').notNull(),
    locale: localeEnum('locale').notNull(),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().default(now),
    messageCount: integer('message_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('conversations_org_agent_idx').on(t.organizationId, t.agent, t.lastMessageAt),
    index('conversations_org_user_idx').on(t.organizationId, t.userId, t.lastMessageAt),
    uniqueIndex('conversations_agent_session_key').on(t.agentSessionId),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: messageRoleEnum('role').notNull(),
    content: text('content').notNull(),
    /**
     * Citations parsed out of the Knowledge agent's prose. The workflow returns
     * no structured sources array — see docs/agent-contracts.md — so this is
     * populated by the citation parser and marked with its confidence in
     * having understood the text.
     */
    citations: jsonb('citations')
      .$type<
        Array<{
          kind: 'document' | 'web';
          label: string;
          url?: string;
        }>
      >()
      .notNull()
      .default([]),
    /** `المصدر:` line the agent emits, normalized. */
    sourceBasis: text('source_basis'),
    /** Links the assistant turn back to the agent_requests row that produced it. */
    agentRequestId: uuid('agent_request_id'),
    /** Thumbs up/down, null when the user has not rated. */
    feedback: integer('feedback'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (t) => [
    index('messages_conversation_idx').on(t.conversationId, t.createdAt),
    index('messages_org_idx').on(t.organizationId, t.createdAt),
    check('messages_feedback_range', sql`${t.feedback} IS NULL OR ${t.feedback} IN (-1, 1)`),
  ],
);

/* ------------------------- agent requests & jobs -------------------------- */

/**
 * One row per invocation of the Agent Gateway. This is the audit spine for all
 * AI activity and the source of every dashboard "requests" metric.
 */
export const agentRequests = pgTable(
  'agent_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Public request id (`req_…`) carried to n8n and back. */
    requestRef: text('request_ref').notNull(),
    correlationId: text('correlation_id').notNull(),
    agent: agentEnum('agent').notNull(),
    action: text('action').notNull(),
    locale: localeEnum('locale').notNull(),
    status: jobStatusEnum('status').notNull().default('QUEUED'),
    /** Request payload with secrets already stripped by the gateway. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    /** Normalized adapter output. */
    result: jsonb('result').$type<Record<string, unknown>>(),
    errorCode: text('error_code'),
    /** Engineer-facing failure detail. Not shown to end users. */
    errorDetail: text('error_detail'),
    /** n8n execution id when the workflow exposes one. Frequently null: the
     *  chat-trigger webhooks do not return it. */
    n8nExecutionId: text('n8n_execution_id'),
    durationMs: integer('duration_ms'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (t) => [
    uniqueIndex('agent_requests_ref_key').on(t.requestRef),
    index('agent_requests_org_created_idx').on(t.organizationId, t.createdAt),
    index('agent_requests_org_agent_idx').on(t.organizationId, t.agent, t.createdAt),
    index('agent_requests_org_status_idx').on(t.organizationId, t.status),
    index('agent_requests_correlation_idx').on(t.correlationId),
  ],
);

/**
 * Long-running work surfaced to the user as a job (§27). A job always has a
 * parent agent_request; the split exists because one request can outlive the
 * HTTP call that started it.
 */
export const agentJobs = pgTable(
  'agent_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    agentRequestId: uuid('agent_request_id')
      .notNull()
      .references(() => agentRequests.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    agent: agentEnum('agent').notNull(),
    action: text('action').notNull(),
    status: jobStatusEnum('status').notNull().default('QUEUED'),
    /** 0-100, when the adapter can report it. */
    progress: integer('progress').notNull().default(0),
    correlationId: text('correlation_id').notNull(),
    n8nExecutionId: text('n8n_execution_id'),
    /**
     * Caller-supplied Idempotency-Key. A repeat of the same key inside the
     * retention window returns the original job instead of starting a new one.
     */
    idempotencyKey: text('idempotency_key'),
    input: jsonb('input').$type<Record<string, unknown>>().notNull().default({}),
    output: jsonb('output').$type<Record<string, unknown>>(),
    errorCode: text('error_code'),
    errorDetail: text('error_detail'),
    attempts: integer('attempts').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
  },
  (t) => [
    index('agent_jobs_org_status_idx').on(t.organizationId, t.status, t.createdAt),
    index('agent_jobs_org_agent_idx').on(t.organizationId, t.agent, t.createdAt),
    index('agent_jobs_request_idx').on(t.agentRequestId),
    // Idempotency is scoped per tenant, so two tenants can reuse the same key.
    uniqueIndex('agent_jobs_idempotency_key')
      .on(t.organizationId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
  ],
);

/* --------------------------- knowledge sources --------------------------- */

/**
 * A connected knowledge origin. Today exactly one row per tenant, describing
 * the Google Drive folder the n8n RAG workflow indexes.
 */
export const knowledgeSources = pgTable(
  'knowledge_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    kind: integrationKindEnum('kind').notNull().default('GOOGLE_DRIVE'),
    /** Google Drive folder id the workflow reads. */
    externalId: text('external_id').notNull(),
    displayName: text('display_name').notNull(),
    /** Mirror of the workflow's supported formats, for UI display. */
    supportedFormats: jsonb('supported_formats')
      .$type<string[]>()
      .notNull()
      .default(['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
    documentCount: integer('document_count'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastSyncStatus: syncStatusEnum('last_sync_status'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
  },
  (t) => [
    uniqueIndex('knowledge_sources_org_external_key').on(t.organizationId, t.externalId),
    index('knowledge_sources_org_idx').on(t.organizationId),
  ],
);

export const knowledgeSyncs = pgTable(
  'knowledge_syncs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    knowledgeSourceId: uuid('knowledge_source_id')
      .notNull()
      .references(() => knowledgeSources.id, { onDelete: 'cascade' }),
    status: syncStatusEnum('status').notNull(),
    /** 'SCHEDULE' when reported by the 6-hourly n8n trigger, 'MANUAL' otherwise. */
    trigger: text('trigger').notNull().default('SCHEDULE'),
    documentsIndexed: integer('documents_indexed'),
    documentsFailed: integer('documents_failed'),
    errorCode: text('error_code'),
    errorDetail: text('error_detail'),
    correlationId: text('correlation_id'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().default(now),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    index('knowledge_syncs_org_started_idx').on(t.organizationId, t.startedAt),
    index('knowledge_syncs_source_idx').on(t.knowledgeSourceId, t.startedAt),
  ],
);

/* --------------------------------- assets -------------------------------- */

export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    agentJobId: uuid('agent_job_id').references(() => agentJobs.id, { onDelete: 'set null' }),
    kind: assetKindEnum('kind').notNull(),
    status: assetStatusEnum('status').notNull().default('PENDING'),
    title: text('title').notNull(),
    /** Object storage key. Media never lives in Postgres (§19). */
    storageKey: text('storage_key'),
    mimeType: text('mime_type'),
    /** bigint: a 4 GB Meta-eligible video overflows int4. */
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    width: integer('width'),
    height: integer('height'),
    durationSeconds: numeric('duration_seconds', { precision: 8, scale: 2 }),
    /** SHA-256 of the bytes; deduplicates repeat generations within a tenant. */
    checksum: text('checksum'),
    /** Prompt, aspect ratio, caption, model — whatever the adapter reported. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('assets_org_created_idx').on(t.organizationId, t.createdAt),
    index('assets_org_kind_idx').on(t.organizationId, t.kind, t.createdAt),
    index('assets_org_status_idx').on(t.organizationId, t.status),
    uniqueIndex('assets_org_checksum_key')
      .on(t.organizationId, t.checksum)
      .where(sql`${t.checksum} IS NOT NULL AND ${t.deletedAt} IS NULL`),
  ],
);

/* -------------------------------- campaigns ------------------------------ */

export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    status: campaignStatusEnum('status').notNull().default('DRAFT'),
    locale: localeEnum('locale').notNull(),

    /* --- brief & configuration, mirroring the n8n intake schema ---------- */
    objective: text('objective').notNull().default('OUTCOME_TRAFFIC'),
    brief: text('brief'),
    primaryText: text('primary_text'),
    headline: text('headline'),
    description: text('description'),
    destinationUrl: text('destination_url'),
    callToAction: text('call_to_action').default('LEARN_MORE'),
    /** One of the four placements the workflow's validator accepts. */
    placement: text('placement').default('Feed 1:1'),

    /* --- audience -------------------------------------------------------- */
    savedAudienceId: text('saved_audience_id'),
    savedAudienceName: text('saved_audience_name'),
    audienceNotes: text('audience_notes'),
    ageMin: integer('age_min'),
    ageMax: integer('age_max'),
    /** 'all' | 'male' | 'female' */
    genders: text('genders').default('all'),
    countries: jsonb('countries').$type<string[]>().notNull().default(['SA']),
    cities: jsonb('cities').$type<string[]>().notNull().default([]),

    /* --- budget & schedule ----------------------------------------------- */
    /** Minor units (halalas for SAR), matching Meta's lifetime_budget. */
    lifetimeBudgetMinor: bigint('lifetime_budget_minor', { mode: 'number' }),
    currency: text('currency').notNull().default('SAR'),
    startDate: timestamp('start_date', { withTimezone: true }),
    endDate: timestamp('end_date', { withTimezone: true }),

    /* --- creative -------------------------------------------------------- */
    assetId: uuid('asset_id').references(() => assets.id, { onDelete: 'set null' }),

    /* --- approval (§21) --------------------------------------------------- */
    approvedByUserId: uuid('approved_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    /** Exact configuration the user saw on the review screen when approving.
     *  Kept immutable so an audit can prove what was authorised. */
    approvedSnapshot: jsonb('approved_snapshot').$type<Record<string, unknown>>(),

    /* --- Meta linkage ---------------------------------------------------- */
    metaAdAccountId: text('meta_ad_account_id'),
    metaPageId: text('meta_page_id'),
    metaCampaignId: text('meta_campaign_id'),
    metaAdSetId: text('meta_ad_set_id'),
    metaAdId: text('meta_ad_id'),
    /**
     * Meta's own status for the created objects. The n8n workflow creates
     * everything PAUSED and never activates, so this is 'PAUSED' after a
     * successful submission — see docs/agent-contracts.md.
     */
    metaObjectStatus: text('meta_object_status'),
    launchedAt: timestamp('launched_at', { withTimezone: true }),
    launchJobId: uuid('launch_job_id').references(() => agentJobs.id, {
      onDelete: 'set null',
    }),
    /**
     * Guards double-submission at the database level. Set at the moment the
     * launch transaction claims the campaign; a second launch with the same key
     * hits this unique index instead of reaching Meta.
     */
    launchIdempotencyKey: text('launch_idempotency_key'),
    lastErrorCode: text('last_error_code'),
    lastErrorDetail: text('last_error_detail'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('campaigns_org_status_idx').on(t.organizationId, t.status, t.createdAt),
    index('campaigns_org_created_idx').on(t.organizationId, t.createdAt),
    uniqueIndex('campaigns_launch_idempotency_key')
      .on(t.organizationId, t.launchIdempotencyKey)
      .where(sql`${t.launchIdempotencyKey} IS NOT NULL`),
    // One Meta campaign maps to at most one row: the hard stop against
    // creating duplicate spend objects.
    uniqueIndex('campaigns_meta_campaign_key')
      .on(t.metaCampaignId)
      .where(sql`${t.metaCampaignId} IS NOT NULL`),
    check(
      'campaigns_age_range',
      sql`(${t.ageMin} IS NULL OR ${t.ageMin} >= 13) AND (${t.ageMax} IS NULL OR ${t.ageMax} <= 65) AND (${t.ageMin} IS NULL OR ${t.ageMax} IS NULL OR ${t.ageMin} <= ${t.ageMax})`,
    ),
    check(
      'campaigns_budget_positive',
      sql`${t.lifetimeBudgetMinor} IS NULL OR ${t.lifetimeBudgetMinor} > 0`,
    ),
    check(
      'campaigns_schedule_order',
      sql`${t.startDate} IS NULL OR ${t.endDate} IS NULL OR ${t.endDate} > ${t.startDate}`,
    ),
  ],
);

/**
 * Daily performance rows pulled from Meta.
 *
 * NOTE: the current n8n advertising workflow contains no insights node, so
 * nothing writes to this table yet. It exists because the schema should not
 * need a migration the day the workflow gains one, and the analytics layer
 * reports "not available" while it is empty rather than inventing numbers.
 */
export const campaignMetrics = pgTable(
  'campaign_metrics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    /** UTC date of the reporting day. */
    date: timestamp('date', { withTimezone: true }).notNull(),
    impressions: bigint('impressions', { mode: 'number' }),
    clicks: bigint('clicks', { mode: 'number' }),
    spendMinor: bigint('spend_minor', { mode: 'number' }),
    conversions: bigint('conversions', { mode: 'number' }),
    conversionValueMinor: bigint('conversion_value_minor', { mode: 'number' }),
    /** Provenance, so the UI can label numbers that came from a stale sync. */
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().default(now),
  },
  (t) => [
    uniqueIndex('campaign_metrics_campaign_date_key').on(t.campaignId, t.date),
    index('campaign_metrics_org_date_idx').on(t.organizationId, t.date),
  ],
);

/* --------------------------------- usage --------------------------------- */

/**
 * Append-only meter (§47). Billing is not implemented, but every billable event
 * is recorded from day one so a future plan/limit/credit system has real
 * history to work from.
 */
export const usageRecords = pgTable(
  'usage_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    metric: usageMetricEnum('metric').notNull(),
    quantity: bigint('quantity', { mode: 'number' }).notNull().default(1),
    agent: agentEnum('agent'),
    /** Ties the meter row to what caused it, for dispute resolution. */
    referenceId: uuid('reference_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().default(now),
  },
  (t) => [
    index('usage_records_org_metric_idx').on(t.organizationId, t.metric, t.occurredAt),
    index('usage_records_org_occurred_idx').on(t.organizationId, t.occurredAt),
  ],
);

/* ------------------------------- audit logs ------------------------------ */

/**
 * Append-only (§35). The application role is granted INSERT and SELECT only;
 * UPDATE and DELETE are revoked in drizzle/0001_rls.sql, so neither a bug nor a
 * compromised app credential can rewrite history.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Nullable: system actions (scheduled syncs, callbacks) have no user. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Preserved verbatim so the log stays readable after a user is deleted. */
    actorEmail: text('actor_email'),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    /** 'SUCCESS' | 'FAILURE' */
    status: text('status').notNull(),
    correlationId: text('correlation_id'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (t) => [
    index('audit_logs_org_created_idx').on(t.organizationId, t.createdAt),
    index('audit_logs_org_action_idx').on(t.organizationId, t.action, t.createdAt),
    index('audit_logs_resource_idx').on(t.organizationId, t.resourceType, t.resourceId),
  ],
);

/* ------------------------------ notifications ---------------------------- */

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: notificationKindEnum('kind').notNull(),
    /**
     * Notifications store an i18n key plus parameters, never rendered text.
     * That is what lets an Arabic notification created while the user was in
     * English render correctly after they switch (§37).
     */
    messageKey: text('message_key').notNull(),
    messageParams: jsonb('message_params')
      .$type<Record<string, string | number>>()
      .notNull()
      .default({}),
    /** In-app deep link, already locale-agnostic (no /ar or /en prefix). */
    href: text('href'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (t) => [
    index('notifications_org_user_idx').on(t.organizationId, t.userId, t.createdAt),
    index('notifications_unread_idx')
      .on(t.userId, t.createdAt)
      .where(sql`${t.readAt} IS NULL`),
  ],
);

/* ------------------------------ system events ---------------------------- */

/**
 * Platform-level health signal, not tenant-scoped content. Used by the
 * dashboard "Platform Health" panel and by the webhook monitor.
 */
export const systemEvents = pgTable(
  'system_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Nullable: some events (n8n unreachable) are platform-wide. */
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    /** 'INFO' | 'WARN' | 'ERROR' */
    severity: text('severity').notNull(),
    source: text('source').notNull(),
    code: text('code').notNull(),
    detail: text('detail'),
    correlationId: text('correlation_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (t) => [
    index('system_events_created_idx').on(t.createdAt),
    index('system_events_org_created_idx').on(t.organizationId, t.createdAt),
    index('system_events_code_idx').on(t.code, t.createdAt),
  ],
);

/* --------------------------- webhook deliveries -------------------------- */

/**
 * Every inbound n8n callback, accepted or rejected. Serves three purposes:
 * replay protection (the unique index on the signature nonce), idempotency
 * (`requestRef` + `event`), and the failed-webhook monitor in §34.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    /** Nonce from the signature header; replayed values are rejected. */
    nonce: text('nonce').notNull(),
    requestRef: text('request_ref'),
    event: text('event').notNull(),
    /** 'ACCEPTED' | 'DUPLICATE' | 'REJECTED' */
    outcome: text('outcome').notNull(),
    rejectionReason: text('rejection_reason'),
    correlationId: text('correlation_id'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().default(now),
    /** Nonce rows are prunable after the replay window closes. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('webhook_deliveries_nonce_key').on(t.nonce),
    index('webhook_deliveries_request_idx').on(t.requestRef),
    index('webhook_deliveries_expiry_idx').on(t.expiresAt),
  ],
);

/* ------------------------------- relations ------------------------------- */

export const organizationsRelations = relations(organizations, ({ many }) => ({
  users: many(users),
  conversations: many(conversations),
  assets: many(assets),
  campaigns: many(campaigns),
  integrations: many(integrations),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [users.organizationId],
    references: [organizations.id],
  }),
  sessions: many(sessions),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [conversations.organizationId],
    references: [organizations.id],
  }),
  user: one(users, { fields: [conversations.userId], references: [users.id] }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
}));

export const campaignsRelations = relations(campaigns, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [campaigns.organizationId],
    references: [organizations.id],
  }),
  asset: one(assets, { fields: [campaigns.assetId], references: [assets.id] }),
  metrics: many(campaignMetrics),
}));

export const assetsRelations = relations(assets, ({ one }) => ({
  organization: one(organizations, {
    fields: [assets.organizationId],
    references: [organizations.id],
  }),
  job: one(agentJobs, { fields: [assets.agentJobId], references: [agentJobs.id] }),
}));

export const agentJobsRelations = relations(agentJobs, ({ one }) => ({
  request: one(agentRequests, {
    fields: [agentJobs.agentRequestId],
    references: [agentRequests.id],
  }),
}));

/* --------------------------- inferred row types -------------------------- */

export type Organization = typeof organizations.$inferSelect;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type AgentRequest = typeof agentRequests.$inferSelect;
export type AgentJob = typeof agentJobs.$inferSelect;
export type Asset = typeof assets.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
export type CampaignMetric = typeof campaignMetrics.$inferSelect;
export type Integration = typeof integrations.$inferSelect;
export type KnowledgeSource = typeof knowledgeSources.$inferSelect;
export type KnowledgeSync = typeof knowledgeSyncs.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type UsageRecord = typeof usageRecords.$inferSelect;
export type SystemEvent = typeof systemEvents.$inferSelect;

/** Union of every table that carries an organizationId. */
export const tenantScopedTables = [
  users,
  sessions,
  integrations,
  conversations,
  messages,
  agentRequests,
  agentJobs,
  knowledgeSources,
  knowledgeSyncs,
  assets,
  campaigns,
  campaignMetrics,
  usageRecords,
  auditLogs,
  notifications,
] as const;

// Referenced so the array is not tree-shaken out of the tenancy tests, which
// assert that every table here really does have an organization_id column.
export type TenantScopedTable = (typeof tenantScopedTables)[number];
