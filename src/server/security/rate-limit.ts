import { sql } from 'drizzle-orm';
import { withoutTenantScope } from '@/server/tenancy/context';
import { AppError } from '@/lib/errors';

/**
 * Rate limiting (§11, §31, §32).
 *
 * Fixed-window counters in Postgres. Redis is the better substrate at scale,
 * but a Postgres limiter that always works beats a Redis limiter that silently
 * no-ops when REDIS_URL is unset — and "no limiter" on a login endpoint is a
 * credential-stuffing invitation. When REDIS_URL is configured the same
 * interface can be backed by Redis without touching call sites.
 *
 * The whole check is one atomic statement. An `INSERT … ON CONFLICT DO UPDATE`
 * that both increments and rolls the window means two concurrent requests
 * cannot both read "count = limit - 1" and both proceed.
 */

export interface RateLimitPolicy {
  /** Bucket name, e.g. `login`, `register`, `agent`. */
  name: string;
  /** Requests permitted per window. */
  limit: number;
  windowSeconds: number;
}

/**
 * Policies for the endpoints that need them.
 *
 * Authentication limits are deliberately tight and are applied per-IP *and*
 * per-account: an IP limit alone lets a botnet spread an attack across
 * addresses, and an account limit alone lets one IP enumerate many accounts.
 */
export const POLICIES = {
  login: { name: 'login', limit: 10, windowSeconds: 300 },
  loginPerAccount: { name: 'login_account', limit: 5, windowSeconds: 900 },
  register: { name: 'register', limit: 5, windowSeconds: 3600 },
  passwordReset: { name: 'password_reset', limit: 5, windowSeconds: 3600 },
  emailVerification: { name: 'email_verification', limit: 5, windowSeconds: 3600 },
  /** Agent calls are expensive downstream; this protects n8n as much as us. */
  agentInvocation: { name: 'agent', limit: 60, windowSeconds: 60 },
  /** Campaign submission reaches Meta and can spend money. */
  campaignLaunch: { name: 'campaign_launch', limit: 10, windowSeconds: 3600 },
  /** Blanket limit for authenticated API traffic. */
  api: { name: 'api', limit: 300, windowSeconds: 60 },
  /** Inbound n8n callbacks. Generous, but not unbounded. */
  webhook: { name: 'webhook', limit: 600, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitPolicy>;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  /** Seconds until the window rolls. Sent as `Retry-After` when blocked. */
  retryAfterSeconds: number;
  resetAt: Date;
}

/**
 * Consumes one unit from a bucket.
 *
 * The subject should be the narrowest stable identifier available — an IP for
 * anonymous traffic, a user id or organization id for authenticated traffic.
 */
export async function consumeRateLimit(
  policy: RateLimitPolicy,
  subject: string,
): Promise<RateLimitResult> {
  const key = `${policy.name}:${subject}`;
  const windowMs = policy.windowSeconds * 1000;

  const rows = await withoutTenantScope('rate-limit:counter', (tx) =>
    tx.execute<{ count: number; window_start: Date }>(sql`
      INSERT INTO rate_limits (key, window_start, count, expires_at)
      VALUES (
        ${key},
        now(),
        1,
        now() + make_interval(secs => ${policy.windowSeconds})
      )
      ON CONFLICT (key) DO UPDATE SET
        -- Roll the window when the stored one has elapsed, otherwise increment.
        window_start = CASE
          WHEN rate_limits.window_start < now() - make_interval(secs => ${policy.windowSeconds})
          THEN now()
          ELSE rate_limits.window_start
        END,
        count = CASE
          WHEN rate_limits.window_start < now() - make_interval(secs => ${policy.windowSeconds})
          THEN 1
          ELSE rate_limits.count + 1
        END,
        expires_at = CASE
          WHEN rate_limits.window_start < now() - make_interval(secs => ${policy.windowSeconds})
          THEN now() + make_interval(secs => ${policy.windowSeconds})
          ELSE rate_limits.expires_at
        END
      RETURNING count, window_start
    `),
  );

  const row = Array.isArray(rows) ? rows[0] : (rows as { rows?: unknown[] }).rows?.[0];
  const record = row as { count: number; window_start: Date } | undefined;

  const count = Number(record?.count ?? 1);
  const windowStart = record?.window_start ? new Date(record.window_start) : new Date();
  const resetAt = new Date(windowStart.getTime() + windowMs);
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((resetAt.getTime() - Date.now()) / 1000),
  );

  return {
    allowed: count <= policy.limit,
    remaining: Math.max(0, policy.limit - count),
    limit: policy.limit,
    retryAfterSeconds,
    resetAt,
  };
}

/** Consumes a unit and throws a localizable 429 when the bucket is empty. */
export async function enforceRateLimit(
  policy: RateLimitPolicy,
  subject: string,
): Promise<RateLimitResult> {
  const result = await consumeRateLimit(policy, subject);

  if (!result.allowed) {
    throw new AppError('rate_limited', {
      params: { seconds: result.retryAfterSeconds },
      internalMessage: `Rate limit ${policy.name} exceeded for ${subject}`,
    });
  }

  return result;
}

/** Maintenance: removes counters whose window has long since closed. */
export async function pruneRateLimits(): Promise<void> {
  await withoutTenantScope('maintenance:prune-expired', (tx) =>
    tx.execute(sql`DELETE FROM rate_limits WHERE expires_at < now() - interval '1 hour'`),
  );
}

/**
 * Best-effort client IP.
 *
 * `X-Forwarded-For` is client-controlled unless a trusted proxy rewrites it, so
 * the LEFTMOST entry is not trustworthy on its own. We take the rightmost
 * non-private entry, which is the address the outermost proxy observed, and
 * fall back to the platform-provided header. Deployments behind more than one
 * proxy hop should set the trusted-hop count in their ingress instead.
 */
export function clientIp(headers: Headers): string {
  const platform =
    headers.get('cf-connecting-ip') ??
    headers.get('x-real-ip') ??
    headers.get('x-vercel-forwarded-for');
  if (platform) return platform.trim();

  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const candidates = forwarded
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const candidate = candidates[i];
      if (candidate && !isPrivateAddress(candidate)) return candidate;
    }
    return candidates[candidates.length - 1] ?? 'unknown';
  }

  return 'unknown';
}

function isPrivateAddress(ip: string): boolean {
  return (
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^127\./.test(ip) ||
    /^::1$/.test(ip) ||
    /^f[cd][0-9a-f]{2}:/i.test(ip)
  );
}
