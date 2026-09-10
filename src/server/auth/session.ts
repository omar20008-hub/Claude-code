import { createHash, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { eq, sql as rawSql } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { sessions } from '@/server/db/schema';
import { withTenant } from '@/server/tenancy/context';
import { secureToken } from '@/lib/ids';
import { env } from '@/server/config/env';
import { AppError } from '@/lib/errors';
import type { Locale } from '@/i18n/config';

/**
 * Session management.
 *
 * Opaque random tokens in an httpOnly cookie, with only a SHA-256 of the token
 * stored server-side. Deliberately not JWTs: this design gives immediate,
 * authoritative revocation (§11), which a stateless token cannot without a
 * denylist that reintroduces the same lookup. A database leak yields hashes,
 * not usable sessions.
 *
 * READS GO THROUGH SECURITY DEFINER FUNCTIONS, NOT DIRECT QUERIES.
 * Resolving a session determines which tenant the caller belongs to, so it
 * cannot itself be tenant-scoped — the scope is the answer, not the question.
 * Under RLS a direct query here returns zero rows and nobody can ever sign in.
 * drizzle/0002_auth_path.sql confines that necessary bypass to a handful of
 * narrow functions rather than granting the application role BYPASSRLS.
 * Writes that *do* know their tenant (issuing a session) use `withTenant`
 * normally.
 */

export const SESSION_COOKIE = '__Host-aiw_session';

/** Absolute lifetime. A session cannot outlive this regardless of activity. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/** Sliding renewal: touch `lastUsedAt` at most this often to avoid a write per request. */
const RENEW_AFTER_MS = 60 * 60 * 1000; // 1 hour
/** Idle timeout, independent of the absolute lifetime. */
const IDLE_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface AuthenticatedSession {
  sessionId: string;
  userId: string;
  organizationId: string;
  email: string;
  name: string;
  role: string;
  /** Resolved preference: user setting, else organization default. */
  locale: Locale;
  organizationName: string;
  organizationSlug: string;
  timezone: string;
  currency: string;
}

/** `__Host-` demands Secure, which plain-HTTP localhost cannot satisfy. */
export function cookieName(): string {
  return env().isProduction ? SESSION_COOKIE : 'aiw_session';
}

/**
 * Issues a session and sets the cookie.
 *
 * Cookie attributes are the security-relevant part:
 *  - `__Host-` prefix: the browser refuses the cookie unless it is Secure,
 *    path=/, and carries no Domain. That stops a subdomain from setting or
 *    overwriting it — session-fixation defence no server check can provide.
 *  - `SameSite=Lax`: not sent on cross-site POSTs, the primary CSRF control.
 *    The Origin check in the API layer is the second.
 *  - `httpOnly`: XSS cannot read the token.
 */
export async function createSession(params: {
  userId: string;
  organizationId: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<{ token: string; expiresAt: Date }> {
  const token = secureToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  // The tenant IS known here, so this is an ordinary scoped write.
  await withTenant({ organizationId: params.organizationId, userId: params.userId }, (tx) =>
    tx.insert(sessions).values({
      userId: params.userId,
      organizationId: params.organizationId,
      tokenHash: hashToken(token),
      expiresAt,
      ipAddress: params.ipAddress ? truncateIp(params.ipAddress) : null,
      userAgent: params.userAgent?.slice(0, 512) ?? null,
    }),
  );

  const store = await cookies();
  store.set(cookieName(), token, {
    httpOnly: true,
    secure: env().isProduction,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });

  return { token, expiresAt };
}

interface ResolvedSessionRow {
  session_id: string;
  last_used_at: string | Date;
  user_id: string;
  organization_id: string;
  email: string;
  name: string;
  role: string;
  user_locale: string | null;
  user_status: string;
  user_deleted_at: string | Date | null;
  organization_name: string;
  organization_slug: string;
  organization_locale: string;
  timezone: string;
  currency: string;
  organization_deleted_at: string | Date | null;
}

function firstRow<T>(result: unknown): T | undefined {
  if (Array.isArray(result)) return result[0] as T | undefined;
  const rows = (result as { rows?: unknown[] }).rows;
  return rows?.[0] as T | undefined;
}

/**
 * Resolves the current session from the cookie.
 *
 * Returns null rather than throwing so callers can distinguish "anonymous"
 * from "error".
 */
export async function getSession(): Promise<AuthenticatedSession | null> {
  const store = await cookies();
  const token = store.get(cookieName())?.value;
  if (!token) return null;

  const tokenHash = hashToken(token);

  const result = await db.execute(
    rawSql`SELECT * FROM auth_resolve_session(${tokenHash})`,
  );
  const row = firstRow<ResolvedSessionRow>(result);
  if (!row) return null;

  const lastUsedAt = new Date(row.last_used_at);

  // Idle timeout is applied here rather than in SQL so the window can change
  // without a migration.
  if (Date.now() - lastUsedAt.getTime() > IDLE_TIMEOUT_MS) return null;

  // A suspended or deleted account keeps no live session, even one issued
  // before the change.
  if (row.user_status !== 'ACTIVE' || row.user_deleted_at || row.organization_deleted_at) {
    return null;
  }

  // Sliding renewal, throttled so a busy tab does not write on every request.
  if (Date.now() - lastUsedAt.getTime() > RENEW_AFTER_MS) {
    await db.execute(rawSql`SELECT auth_touch_session(${row.session_id}::uuid)`);
  }

  return {
    sessionId: row.session_id,
    userId: row.user_id,
    organizationId: row.organization_id,
    email: row.email,
    name: row.name,
    role: row.role,
    locale: (row.user_locale ?? row.organization_locale) as Locale,
    organizationName: row.organization_name,
    organizationSlug: row.organization_slug,
    timezone: row.timezone,
    currency: row.currency,
  };
}

/** Session or 401. The standard guard for every authenticated route. */
export async function requireSession(): Promise<AuthenticatedSession> {
  const session = await getSession();
  if (!session) throw new AppError('unauthorized');
  return session;
}

/** Revokes the current session and clears the cookie. */
export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(cookieName())?.value;

  if (token) {
    await db.execute(rawSql`SELECT auth_revoke_session(${hashToken(token)})`);
  }

  store.delete(cookieName());
}

/**
 * Revokes every session for a user.
 *
 * Called after a password change or reset: an attacker who already holds a
 * session must lose it the moment the owner recovers the account.
 */
export async function revokeAllSessions(userId: string): Promise<number> {
  const result = await db.execute(
    rawSql`SELECT auth_revoke_user_sessions(${userId}::uuid) AS revoked`,
  );
  const row = firstRow<{ revoked: number | string }>(result);
  return Number(row?.revoked ?? 0);
}

/** Maintenance: drops sessions that are expired, idle-timed-out or revoked. */
export async function pruneSessions(): Promise<number> {
  const idleInterval = `${Math.floor(IDLE_TIMEOUT_MS / 1000)} seconds`;
  const result = await db.execute(
    rawSql`SELECT auth_prune_sessions(${idleInterval}::interval) AS pruned`,
  );
  const row = firstRow<{ pruned: number | string }>(result);
  return Number(row?.pruned ?? 0);
}

/** Lists a user's live sessions, for the security panel. Tenant-scoped. */
export async function listSessions(params: {
  organizationId: string;
  userId: string;
}): Promise<
  Array<{ id: string; lastUsedAt: Date; ipAddress: string | null; userAgent: string | null }>
> {
  return withTenant({ organizationId: params.organizationId }, (tx) =>
    tx
      .select({
        id: sessions.id,
        lastUsedAt: sessions.lastUsedAt,
        ipAddress: sessions.ipAddress,
        userAgent: sessions.userAgent,
      })
      .from(sessions)
      .where(eq(sessions.userId, params.userId)),
  );
}

/**
 * Drops the last octet of an IPv4 address / the interface half of an IPv6 one.
 * Enough to spot a session used from an unexpected network, without retaining a
 * precise location for every request.
 */
function truncateIp(ip: string): string {
  if (ip.includes(':')) {
    return ip.split(':').slice(0, 4).join(':') + '::';
  }
  const parts = ip.split('.');
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  return ip.slice(0, 45);
}

/** Constant-time comparison for equal-length values. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export { hashToken };
export const __testing = { SESSION_TTL_MS, IDLE_TIMEOUT_MS, RENEW_AFTER_MS, truncateIp };
