import { createHash, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { and, eq, gt, isNull, lt, or } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { sessions, users, organizations } from '@/server/db/schema';
import { withoutTenantScope } from '@/server/tenancy/context';
import { secureToken } from '@/lib/ids';
import { env } from '@/server/config/env';
import { AppError } from '@/lib/errors';
import type { Locale } from '@/i18n/config';

/**
 * Session management.
 *
 * Opaque random tokens in an httpOnly cookie, with only a SHA-256 of the token
 * stored server-side. Deliberately not JWTs: this design gives immediate,
 * authoritative revocation (§11 "session invalidation"), which a stateless
 * token cannot without a denylist that reintroduces the same lookup.
 *
 * A database leak yields hashes, not usable sessions.
 */

export const SESSION_COOKIE = '__Host-aiw_session';

/** Absolute lifetime. A session cannot outlive this regardless of activity. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/** Sliding renewal: touch `lastUsedAt` at most this often to avoid a write per request. */
const RENEW_AFTER_MS = 60 * 60 * 1000; // 1 hour
/** Idle timeout. Independent of the absolute lifetime. */
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

/**
 * Issues a session and sets the cookie.
 *
 * Cookie attributes are the security-relevant part:
 *  - `__Host-` prefix: the browser refuses the cookie unless it is Secure,
 *    path=/, and has no Domain attribute. That forbids a subdomain from
 *    setting or overwriting it — session fixation defence that no server-side
 *    check can provide.
 *  - `SameSite=Lax`: the cookie is not sent on cross-site POSTs, which is the
 *    primary CSRF control. The Origin check in the API layer is the second.
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

  await withoutTenantScope('auth:resolve-session', (tx) =>
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
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    // __Host- requires Secure. In local HTTP development the browser would
    // reject the cookie, so the prefix is dropped there — see cookieName().
    secure: env().isProduction,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });

  return { token, expiresAt };
}

/** `__Host-` demands Secure, which plain-HTTP localhost cannot satisfy. */
export function cookieName(): string {
  return env().isProduction ? SESSION_COOKIE : 'aiw_session';
}

/**
 * Resolves the current session from the cookie.
 *
 * Returns null rather than throwing so callers can distinguish "anonymous"
 * from "error". Runs unscoped by necessity: the tenant is what we are
 * resolving. It reads only the sessions/users/organizations join needed to
 * establish identity.
 */
export async function getSession(): Promise<AuthenticatedSession | null> {
  const store = await cookies();
  const token = store.get(cookieName())?.value;
  if (!token) return null;

  const tokenHash = hashToken(token);
  const idleCutoff = new Date(Date.now() - IDLE_TIMEOUT_MS);

  const rows = await withoutTenantScope('auth:resolve-session', (tx) =>
    tx
      .select({
        sessionId: sessions.id,
        lastUsedAt: sessions.lastUsedAt,
        userId: users.id,
        organizationId: users.organizationId,
        email: users.email,
        name: users.name,
        role: users.role,
        userLocale: users.localePreference,
        userStatus: users.status,
        userDeletedAt: users.deletedAt,
        organizationName: organizations.name,
        organizationSlug: organizations.slug,
        organizationLocale: organizations.defaultLocale,
        timezone: organizations.timezone,
        currency: organizations.currency,
        organizationDeletedAt: organizations.deletedAt,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .innerJoin(organizations, eq(organizations.id, users.organizationId))
      .where(
        and(
          eq(sessions.tokenHash, tokenHash),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, new Date()),
          gt(sessions.lastUsedAt, idleCutoff),
        ),
      )
      .limit(1),
  );

  const row = rows[0];
  if (!row) return null;

  // A suspended or deleted account keeps no live session, even one issued
  // before the change.
  if (row.userStatus !== 'ACTIVE' || row.userDeletedAt || row.organizationDeletedAt) {
    return null;
  }

  // Sliding renewal, throttled so a busy tab does not write on every request.
  if (Date.now() - row.lastUsedAt.getTime() > RENEW_AFTER_MS) {
    await withoutTenantScope('auth:resolve-session', (tx) =>
      tx
        .update(sessions)
        .set({ lastUsedAt: new Date() })
        .where(eq(sessions.id, row.sessionId)),
    );
  }

  return {
    sessionId: row.sessionId,
    userId: row.userId,
    organizationId: row.organizationId,
    email: row.email,
    name: row.name,
    role: row.role,
    locale: (row.userLocale ?? row.organizationLocale) as Locale,
    organizationName: row.organizationName,
    organizationSlug: row.organizationSlug,
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
    await withoutTenantScope('auth:resolve-session', (tx) =>
      tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(eq(sessions.tokenHash, hashToken(token))),
    );
  }

  store.delete(cookieName());
}

/**
 * Revokes every session for a user.
 *
 * Called after a password change or reset: an attacker who already had a
 * session must not keep it once the owner recovers the account.
 */
export async function revokeAllSessions(userId: string): Promise<number> {
  const result = await withoutTenantScope('auth:resolve-session', (tx) =>
    tx
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id }),
  );
  return result.length;
}

/** Maintenance: drops sessions that are expired, idle-timed-out or revoked. */
export async function pruneSessions(): Promise<number> {
  const nowTs = new Date();
  const idleCutoff = new Date(Date.now() - IDLE_TIMEOUT_MS);

  const deleted = await withoutTenantScope('maintenance:prune-expired', (tx) =>
    tx
      .delete(sessions)
      .where(
        or(
          lt(sessions.expiresAt, nowTs),
          lt(sessions.lastUsedAt, idleCutoff),
          lt(sessions.revokedAt, nowTs),
        ),
      )
      .returning({ id: sessions.id }),
  );
  return deleted.length;
}

/**
 * Drops the last octet of an IPv4 address / the interface half of an IPv6 one.
 * Enough to spot a session used from an unexpected network, without retaining
 * a precise location for every request.
 */
function truncateIp(ip: string): string {
  if (ip.includes(':')) {
    return ip.split(':').slice(0, 4).join(':') + '::';
  }
  const parts = ip.split('.');
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  return ip.slice(0, 45);
}

/** Constant-time string comparison for non-secret-length values. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export { hashToken };
export const __testing = { SESSION_TTL_MS, IDLE_TIMEOUT_MS, RENEW_AFTER_MS, truncateIp };

/** Re-exported so callers don't need to reach into the client module. */
export { db };
