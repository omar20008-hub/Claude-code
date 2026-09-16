import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { withTenant } from '@/server/tenancy/context';
import { auditLogs, systemEvents } from '@/server/db/schema';
import type { Transaction } from '@/server/db/client';
import { logger } from '@/server/observability/logger';

/**
 * Audit logging (§35).
 *
 * Rows are append-only: the application role has no UPDATE or DELETE privilege
 * on `audit_logs`, and a trigger rejects both even for the table owner. The
 * only way to change history is a DBA disabling that trigger deliberately.
 *
 * A failure to write an audit row must never fail the operation being audited —
 * refusing a successful login because a log insert timed out is worse than the
 * missing row. So writes are best-effort and a failure is escalated loudly to
 * the system event log instead.
 */

/**
 * The closed set of audited actions. Each value is also an i18n key under
 * `activity.actions.*`, which is what lets the Activity page render every
 * entry in the reader's language rather than storing English prose.
 */
export type AuditAction =
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'auth.register'
  | 'auth.email_verified'
  | 'auth.password_reset_requested'
  | 'auth.password_reset'
  | 'auth.sessions_revoked'
  | 'agent.invoked'
  | 'agent.failed'
  | 'knowledge.query'
  | 'knowledge.sync'
  | 'conversation.created'
  | 'conversation.deleted'
  | 'asset.generated'
  | 'asset.deleted'
  | 'campaign.created'
  | 'campaign.updated'
  | 'campaign.approved'
  | 'campaign.launched'
  | 'campaign.launch_failed'
  | 'campaign.deleted'
  | 'integration.connected'
  | 'integration.disconnected'
  | 'settings.updated'
  | 'webhook.rejected';

export interface AuditEntry {
  organizationId: string;
  userId?: string | null;
  actorEmail?: string | null;
  action: AuditAction;
  resourceType: string;
  resourceId?: string | null;
  status: 'SUCCESS' | 'FAILURE';
  correlationId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

/** Keys that must never reach an audit row's metadata. */
const FORBIDDEN_METADATA_KEYS = new Set([
  'password',
  'passwordHash',
  'token',
  'tokenHash',
  'secret',
  'apiKey',
  'accessToken',
  'refreshToken',
  'authorization',
  'cookie',
  'base64',
  'signature',
]);

/**
 * Defence in depth over pino's redaction: the logger protects log output, this
 * protects what is persisted. An audit trail that leaks a token is worse than
 * no audit trail.
 */
function sanitizeMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!metadata) return {};

  const clean = (value: unknown, depth: number): unknown => {
    if (depth > 4) return '[truncated]';
    if (Array.isArray(value)) return value.slice(0, 50).map((v) => clean(v, depth + 1));
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        if (FORBIDDEN_METADATA_KEYS.has(key)) continue;
        out[key] = clean(nested, depth + 1);
      }
      return out;
    }
    // Keep a long free-text field from bloating the table.
    if (typeof value === 'string' && value.length > 2000) return `${value.slice(0, 2000)}…`;
    return value;
  };

  return clean(metadata, 0) as Record<string, unknown>;
}

/**
 * Records an audit event.
 *
 * Pass `tx` when the event must be atomic with the change it describes — a
 * campaign launch, for example, where a committed launch with no audit row
 * would be a compliance gap. Omit it for events that stand alone.
 */
export async function recordAudit(
  entry: AuditEntry,
  tx?: Transaction,
): Promise<void> {
  const values = {
    organizationId: entry.organizationId,
    userId: entry.userId ?? null,
    actorEmail: entry.actorEmail ?? null,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId ?? null,
    status: entry.status,
    correlationId: entry.correlationId ?? null,
    ipAddress: entry.ipAddress ?? null,
    userAgent: entry.userAgent?.slice(0, 512) ?? null,
    metadata: sanitizeMetadata(entry.metadata),
  };

  try {
    if (tx) {
      await tx.insert(auditLogs).values(values);
      return;
    }

    await withTenant({ organizationId: entry.organizationId }, (scoped) =>
      scoped.insert(auditLogs).values(values),
    );
  } catch (error) {
    // Never let an audit failure take down the operation it describes. Escalate
    // it instead: a missing audit row is a security-relevant incident.
    logger.error(
      {
        action: entry.action,
        tenantId: entry.organizationId,
        correlationId: entry.correlationId,
        err: error instanceof Error ? error.message : String(error),
      },
      'failed to write audit log entry',
    );

    if (!tx) {
      await recordSystemEvent({
        organizationId: entry.organizationId,
        severity: 'ERROR',
        source: 'audit',
        code: 'audit_write_failed',
        detail: `Could not record ${entry.action}`,
        correlationId: entry.correlationId ?? undefined,
      }).catch(() => {
        /* Already logged; nothing further to do. */
      });
    }
  }
}

export interface SystemEventEntry {
  organizationId?: string | null;
  severity: 'INFO' | 'WARN' | 'ERROR';
  source: string;
  code: string;
  detail?: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Platform health signal, distinct from the tenant audit trail.
 *
 * Written outside `withTenant` because some events (n8n unreachable, a rejected
 * callback we could not attribute) legitimately belong to no tenant. The RLS
 * policy on system_events admits NULL-tenant rows for exactly this case.
 */
export async function recordSystemEvent(entry: SystemEventEntry): Promise<void> {
  const values = {
    organizationId: entry.organizationId ?? null,
    severity: entry.severity,
    source: entry.source,
    code: entry.code,
    detail: entry.detail?.slice(0, 4000) ?? null,
    correlationId: entry.correlationId ?? null,
    metadata: sanitizeMetadata(entry.metadata),
  };

  try {
    if (entry.organizationId) {
      await withTenant({ organizationId: entry.organizationId }, (tx) =>
        tx.insert(systemEvents).values(values),
      );
    } else {
      // Platform-scoped: no tenant to pin, so this runs unscoped and the
      // policy's `organization_id IS NULL` branch admits it.
      const { db } = await import('@/server/db/client');
      await db.insert(systemEvents).values(values);
    }
  } catch (error) {
    logger.error(
      { code: entry.code, err: error instanceof Error ? error.message : String(error) },
      'failed to write system event',
    );
  }
}

export interface AuditQuery {
  organizationId: string;
  action?: AuditAction;
  userId?: string;
  resourceType?: string;
  status?: 'SUCCESS' | 'FAILURE';
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

/** Reads the audit trail, newest first, always tenant-scoped. */
export async function queryAuditLogs(query: AuditQuery): Promise<{
  entries: (typeof auditLogs.$inferSelect)[];
  total: number;
}> {
  const limit = Math.min(query.limit ?? 50, 200);
  const offset = Math.max(query.offset ?? 0, 0);

  const conditions: SQL[] = [eq(auditLogs.organizationId, query.organizationId)];
  if (query.action) conditions.push(eq(auditLogs.action, query.action));
  if (query.userId) conditions.push(eq(auditLogs.userId, query.userId));
  if (query.resourceType) conditions.push(eq(auditLogs.resourceType, query.resourceType));
  if (query.status) conditions.push(eq(auditLogs.status, query.status));
  if (query.from) conditions.push(gte(auditLogs.createdAt, query.from));
  if (query.to) conditions.push(lte(auditLogs.createdAt, query.to));

  const where = and(...conditions);

  return withTenant({ organizationId: query.organizationId }, async (tx) => {
    const [entries, counted] = await Promise.all([
      tx
        .select()
        .from(auditLogs)
        .where(where)
        .orderBy(desc(auditLogs.createdAt))
        .limit(limit)
        .offset(offset),
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(auditLogs)
        .where(where),
    ]);

    return { entries, total: counted[0]?.count ?? 0 };
  });
}
