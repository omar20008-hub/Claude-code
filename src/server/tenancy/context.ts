import { sql as rawSql } from 'drizzle-orm';
import { db, type Transaction } from '@/server/db/client';
import { AppError } from '@/lib/errors';

/**
 * Tenant scoping.
 *
 * `withTenant` is the ONLY sanctioned way for application code to touch a
 * tenant-owned table. It opens a transaction, pins `app.organization_id` for
 * the life of that transaction, and hands the caller a transaction handle.
 * Every statement issued on that handle is therefore filtered by the RLS
 * policies in drizzle/0001_rls.sql.
 *
 * Two independent controls, as §9 requires:
 *   1. This function sets the database-enforced scope.
 *   2. Repository queries still carry an explicit `organizationId` predicate,
 *      so the intent is visible in the code and the query planner gets an
 *      index-friendly filter.
 *
 * Neither control depends on the other being correct.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Guards the one place a value is interpolated into SQL rather than bound as a
 * parameter: `SET LOCAL` does not accept bind parameters in Postgres.
 * Validating against a strict UUID pattern before interpolation is what keeps
 * that safe.
 */
function assertUuid(value: string, label: string): string {
  if (!UUID_RE.test(value)) {
    throw new AppError('internal_error', {
      internalMessage: `${label} is not a valid UUID: refusing to build a tenant scope from it`,
    });
  }
  return value;
}

export interface TenantContext {
  organizationId: string;
  userId?: string;
}

/**
 * Runs `fn` inside a transaction scoped to one organization.
 *
 * @example
 *   const rows = await withTenant({ organizationId }, (tx) =>
 *     tx.select().from(campaigns).where(eq(campaigns.organizationId, organizationId)),
 *   );
 */
export async function withTenant<T>(
  context: TenantContext,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const organizationId = assertUuid(context.organizationId, 'organizationId');

  return db.transaction(async (tx) => {
    // SET LOCAL is scoped to this transaction and is reset on COMMIT/ROLLBACK,
    // so a pooled connection can never leak one tenant's scope into the next
    // checkout.
    await tx.execute(
      rawSql.raw(`SET LOCAL app.organization_id = '${organizationId}'`),
    );

    if (context.userId) {
      const userId = assertUuid(context.userId, 'userId');
      // Not read by any policy today; recorded so `pg_stat_activity` and slow
      // query logs attribute a statement to a person during an incident.
      await tx.execute(rawSql.raw(`SET LOCAL app.user_id = '${userId}'`));
    }

    return fn(tx);
  });
}

/**
 * Escape hatch for the handful of operations that legitimately precede a known
 * tenant: looking a user up by email at login, redeeming a verification token,
 * reading the rate-limit counters, and resolving an inbound webhook to its
 * tenant.
 *
 * It is deliberately named to be conspicuous in review, takes a written reason,
 * and only ever touches tables that carry no tenant content (see the comments
 * in drizzle/0001_rls.sql). Using it on a tenant table returns zero rows,
 * because RLS remains fail-closed with no scope set.
 */
export async function withoutTenantScope<T>(
  reason: UnscopedReason,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  void reason;
  return db.transaction(fn);
}

/**
 * The complete, closed set of operations allowed to run unscoped. Adding a case
 * requires editing this union, which forces the decision through code review.
 */
export type UnscopedReason =
  | 'auth:lookup-user-by-email'
  | 'auth:register-organization'
  | 'auth:redeem-token'
  | 'auth:resolve-session'
  | 'rate-limit:counter'
  | 'webhook:resolve-tenant'
  | 'maintenance:prune-expired';
