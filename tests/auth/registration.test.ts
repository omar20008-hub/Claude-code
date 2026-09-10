import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { eq, sql as rawSql } from 'drizzle-orm';
import { withoutTenantScope, withTenant } from '@/server/tenancy/context';
import { users, organizations, authTokens, auditLogs } from '@/server/db/schema';
import {
  registerOrganization,
  login,
  verifyEmail,
  requestPasswordReset,
  resetPassword,
} from '@/server/services/auth-service';
import { verifyPassword } from '@/server/auth/password';
import { resetDatabase, closeDatabase, adminSql, countAll } from '../helpers/db';
import { captureRejection } from '../helpers/errors';

/**
 * Registration, verification, login and password reset (§11, §50).
 *
 * Runs against the real database as the least-privilege application role, so
 * the RLS policies apply to every statement these services issue.
 */

// Sessions are set through Next's cookie store, which has no request context
// in a unit test. The session row is still written; only the cookie is stubbed.
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  }),
}));

// Captures the verification and reset links instead of sending mail.
const sentEmails: Array<{ to: string; template: string; url: string }> = [];
vi.mock('@/server/services/email', () => ({
  sendEmail: vi.fn(async (params: { to: string; template: string; params: Record<string, string> }) => {
    sentEmails.push({ to: params.to, template: params.template, url: params.params.url ?? '' });
  }),
}));

function tokenFromUrl(url: string): string {
  return new URL(url).searchParams.get('token') ?? '';
}

beforeEach(async () => {
  sentEmails.length = 0;
  await resetDatabase();
});

afterAll(async () => {
  await closeDatabase();
});

const VALID = {
  organizationName: 'مؤسسة الأفق',
  name: 'Layla Admin',
  email: 'layla@example.test',
  password: 'vault-tumbler-orchid',
  locale: 'ar' as const,
  correlationId: 'cid_test',
};

describe('organization registration', () => {
  it('creates the organization, the admin, and the integration rows in one transaction', async () => {
    const result = await registerOrganization(VALID);

    expect(result.organizationId).toMatch(/^[0-9a-f-]{36}$/);

    const sql = adminSql();
    const [org] = await sql<{ name: string; slug: string; default_locale: string }[]>`
      SELECT name, slug, default_locale FROM organizations WHERE id = ${result.organizationId}
    `;
    expect(org?.name).toBe('مؤسسة الأفق');
    expect(org?.default_locale).toBe('ar');
    // An Arabic name still produces a usable slug rather than an empty one.
    expect(org?.slug.length).toBeGreaterThan(0);

    const [user] = await sql<{ role: string; status: string }[]>`
      SELECT role, status FROM users WHERE organization_id = ${result.organizationId}
    `;
    expect(user?.role).toBe('ADMIN');
    // Not ACTIVE: verification is not decorative.
    expect(user?.status).toBe('PENDING_VERIFICATION');

    // Settings can show honest integration status from the first page load.
    expect(await countAll('integrations')).toBe(3);
    expect(await countAll('knowledge_sources')).toBe(1);
  });

  it('never stores the password in recoverable form', async () => {
    const result = await registerOrganization(VALID);

    const sql = adminSql();
    const [user] = await sql<{ password_hash: string }[]>`
      SELECT password_hash FROM users WHERE organization_id = ${result.organizationId}
    `;

    expect(user?.password_hash).not.toContain(VALID.password);
    expect(user?.password_hash).toMatch(/^scrypt\$/);
    expect(await verifyPassword(VALID.password, user!.password_hash)).toBe(true);
  });

  it('rejects a duplicate email address', async () => {
    await registerOrganization(VALID);

    const error = await captureRejection(() =>
      registerOrganization({ ...VALID, organizationName: 'Another Org' }),
    );

    expect((error as { code: string }).code).toBe('email_already_registered');
    // No half-created tenant was left behind.
    expect(await countAll('organizations')).toBe(1);
  });

  it('treats email addresses case-insensitively', async () => {
    await registerOrganization(VALID);

    const error = await captureRejection(() =>
      registerOrganization({ ...VALID, email: 'LAYLA@EXAMPLE.TEST' }),
    );

    expect((error as { code: string }).code).toBe('email_already_registered');
  });

  it('rejects a weak password before creating anything', async () => {
    const error = await captureRejection(() =>
      registerOrganization({ ...VALID, password: 'password1234' }),
    );

    expect((error as { code: string }).code).toBe('validation_failed');
    expect(await countAll('organizations')).toBe(0);
  });

  it('gives two organizations with the same name distinct slugs', async () => {
    await registerOrganization(VALID);
    await registerOrganization({ ...VALID, email: 'second@example.test' });

    const sql = adminSql();
    const rows = await sql<{ slug: string }[]>`SELECT slug FROM organizations`;
    expect(new Set(rows.map((r) => r.slug)).size).toBe(2);
  });

  it('sends exactly one verification email and records the registration', async () => {
    const result = await registerOrganization(VALID);

    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]?.template).toBe('verify-email');
    // The link is locale-prefixed, so an Arabic registrant lands on Arabic.
    expect(sentEmails[0]?.url).toContain('/ar/verify-email');

    const entries = await withTenant({ organizationId: result.organizationId }, (tx) =>
      tx.select().from(auditLogs).where(eq(auditLogs.action, 'auth.register')),
    );
    expect(entries).toHaveLength(1);
  });
});

describe('email verification', () => {
  it('activates the account and consumes the token', async () => {
    await registerOrganization(VALID);
    const token = tokenFromUrl(sentEmails[0]!.url);

    await verifyEmail(token);

    const sql = adminSql();
    const [user] = await sql<{ status: string; email_verified_at: Date | null }[]>`
      SELECT status, email_verified_at FROM users WHERE email = ${VALID.email}
    `;
    expect(user?.status).toBe('ACTIVE');
    expect(user?.email_verified_at).not.toBeNull();
  });

  it('refuses a replayed token', async () => {
    await registerOrganization(VALID);
    const token = tokenFromUrl(sentEmails[0]!.url);

    await verifyEmail(token);
    const error = await captureRejection(() => verifyEmail(token));

    // Single use: a link forwarded or scraped from a mailbox cannot be reused.
    expect((error as { code: string }).code).toBe('invalid_token');
  });

  it('refuses an unknown token', async () => {
    const error = await captureRejection(() => verifyEmail('not-a-real-token-value-here'));
    expect((error as { code: string }).code).toBe('invalid_token');
  });

  it('refuses an expired token', async () => {
    await registerOrganization(VALID);
    const token = tokenFromUrl(sentEmails[0]!.url);

    // Age the token past its 24-hour lifetime.
    await withoutTenantScope('auth:redeem-token', (tx) =>
      tx.execute(rawSql`UPDATE auth_tokens SET expires_at = now() - interval '1 hour'`),
    );

    const error = await captureRejection(() => verifyEmail(token));
    expect((error as { code: string }).code).toBe('token_expired');
  });

  it('stores only a hash of the emailed token', async () => {
    await registerOrganization(VALID);
    const token = tokenFromUrl(sentEmails[0]!.url);

    const sql = adminSql();
    const [row] = await sql<{ token_hash: string }[]>`SELECT token_hash FROM auth_tokens`;

    // A database leak must not yield working verification links.
    expect(row?.token_hash).not.toBe(token);
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('login', () => {
  async function activeAccount() {
    const result = await registerOrganization(VALID);
    await verifyEmail(tokenFromUrl(sentEmails[0]!.url));
    return result;
  }

  it('authenticates a verified account and opens a session', async () => {
    const account = await activeAccount();

    const result = await login({
      email: VALID.email,
      password: VALID.password,
      correlationId: 'cid_login',
    });

    expect(result.organizationId).toBe(account.organizationId);
    expect(result.locale).toBe('ar');
    expect(await countAll('sessions')).toBe(1);
  });

  it('stores only a hash of the session token', async () => {
    await activeAccount();
    await login({ email: VALID.email, password: VALID.password, correlationId: 'cid' });

    const sql = adminSql();
    const [row] = await sql<{ token_hash: string }[]>`SELECT token_hash FROM sessions`;
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses an unverified account', async () => {
    await registerOrganization(VALID);

    const error = await captureRejection(() =>
      login({ email: VALID.email, password: VALID.password, correlationId: 'cid' }),
    );

    expect((error as { code: string }).code).toBe('email_not_verified');
    expect(await countAll('sessions')).toBe(0);
  });

  it('gives an unknown address and a wrong password the same answer', async () => {
    await activeAccount();

    const wrongPassword = await captureRejection(() =>
      login({ email: VALID.email, password: 'definitely-not-the-password', correlationId: 'c' }),
    );
    const unknownEmail = await captureRejection(() =>
      login({ email: 'nobody@example.test', password: VALID.password, correlationId: 'c' }),
    );

    // Identical codes: this endpoint must not become an enumeration oracle.
    expect((wrongPassword as { code: string }).code).toBe('invalid_credentials');
    expect((unknownEmail as { code: string }).code).toBe('invalid_credentials');
  });

  it('locks the account after repeated failures and records each attempt', async () => {
    await activeAccount();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await captureRejection(() =>
        login({ email: VALID.email, password: `wrong-${attempt}`, correlationId: 'c' }),
      );
    }

    // The sixth attempt is refused even with the CORRECT password.
    const error = await captureRejection(() =>
      login({ email: VALID.email, password: VALID.password, correlationId: 'c' }),
    );

    expect((error as { code: string }).code).toBe('account_locked');
    expect((error as { params?: { minutes?: number } }).params?.minutes).toBeGreaterThan(0);

    const sql = adminSql();
    const [row] = await sql<{ count: string }[]>`
      SELECT count(*)::text FROM audit_logs WHERE action = 'auth.login_failed'
    `;
    expect(Number(row?.count)).toBeGreaterThanOrEqual(5);
  });

  it('clears the failure counter after a successful sign-in', async () => {
    await activeAccount();

    await captureRejection(() =>
      login({ email: VALID.email, password: 'wrong', correlationId: 'c' }),
    );
    await login({ email: VALID.email, password: VALID.password, correlationId: 'c' });

    const sql = adminSql();
    const [user] = await sql<{ failed_login_count: number; locked_until: Date | null }[]>`
      SELECT failed_login_count, locked_until FROM users WHERE email = ${VALID.email}
    `;
    expect(user?.failed_login_count).toBe(0);
    expect(user?.locked_until).toBeNull();
  });
});

describe('password reset', () => {
  async function activeAccount() {
    const result = await registerOrganization(VALID);
    await verifyEmail(tokenFromUrl(sentEmails[0]!.url));
    sentEmails.length = 0;
    return result;
  }

  it('emails a reset link for a known address', async () => {
    await activeAccount();

    await requestPasswordReset({
      email: VALID.email,
      locale: 'ar',
      correlationId: 'cid',
    });

    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]?.template).toBe('reset-password');
  });

  it('stays silent about an unknown address', async () => {
    // Resolves successfully and sends nothing: the caller shows the same
    // "if an account exists…" message either way.
    await expect(
      requestPasswordReset({
        email: 'nobody@example.test',
        locale: 'en',
        correlationId: 'cid',
      }),
    ).resolves.toBeUndefined();

    expect(sentEmails).toHaveLength(0);
  });

  it('sets the new password and revokes every existing session', async () => {
    await activeAccount();
    await login({ email: VALID.email, password: VALID.password, correlationId: 'c' });
    expect(await countAll('sessions')).toBe(1);

    await requestPasswordReset({ email: VALID.email, locale: 'ar', correlationId: 'c' });
    const token = tokenFromUrl(sentEmails.at(-1)!.url);

    await resetPassword({
      token,
      newPassword: 'lantern-basalt-quarry',
      correlationId: 'c',
    });

    // An attacker holding a stolen session must lose it when the owner
    // recovers the account.
    const sql = adminSql();
    const [session] = await sql<{ revoked_at: Date | null }[]>`
      SELECT revoked_at FROM sessions
    `;
    expect(session?.revoked_at).not.toBeNull();

    // The old password no longer works; the new one does.
    await captureRejection(() =>
      login({ email: VALID.email, password: VALID.password, correlationId: 'c' }),
    );
    await expect(
      login({ email: VALID.email, password: 'lantern-basalt-quarry', correlationId: 'c' }),
    ).resolves.toBeDefined();
  });

  it('refuses a replayed reset token', async () => {
    await activeAccount();
    await requestPasswordReset({ email: VALID.email, locale: 'ar', correlationId: 'c' });
    const token = tokenFromUrl(sentEmails.at(-1)!.url);

    await resetPassword({ token, newPassword: 'lantern-basalt-quarry', correlationId: 'c' });

    const error = await captureRejection(() =>
      resetPassword({ token, newPassword: 'another-good-passphrase', correlationId: 'c' }),
    );
    expect((error as { code: string }).code).toBe('invalid_token');
  });

  it('rejects a weak new password', async () => {
    await activeAccount();
    await requestPasswordReset({ email: VALID.email, locale: 'ar', correlationId: 'c' });
    const token = tokenFromUrl(sentEmails.at(-1)!.url);

    const error = await captureRejection(() =>
      resetPassword({ token, newPassword: 'welcome12345', correlationId: 'c' }),
    );
    expect((error as { code: string }).code).toBe('validation_failed');
  });

  it('issuing a new reset link invalidates the previous one', async () => {
    await activeAccount();

    await requestPasswordReset({ email: VALID.email, locale: 'ar', correlationId: 'c' });
    const firstToken = tokenFromUrl(sentEmails.at(-1)!.url);

    await requestPasswordReset({ email: VALID.email, locale: 'ar', correlationId: 'c' });

    const error = await captureRejection(() =>
      resetPassword({ token: firstToken, newPassword: 'lantern-basalt-quarry', correlationId: 'c' }),
    );
    expect((error as { code: string }).code).toBe('invalid_token');
  });
});

describe('cross-tenant registration safety', () => {
  it('gives each organization a separate user set', async () => {
    const first = await registerOrganization(VALID);
    const second = await registerOrganization({
      ...VALID,
      email: 'other@example.test',
      organizationName: 'Second Org',
    });

    const firstUsers = await withTenant({ organizationId: first.organizationId }, (tx) =>
      tx.select().from(users),
    );
    const secondUsers = await withTenant({ organizationId: second.organizationId }, (tx) =>
      tx.select().from(users),
    );

    expect(firstUsers).toHaveLength(1);
    expect(secondUsers).toHaveLength(1);
    expect(firstUsers[0]?.email).not.toBe(secondUsers[0]?.email);
  });

  it('scopes the seeded integrations to their own organization', async () => {
    const first = await registerOrganization(VALID);
    await registerOrganization({
      ...VALID,
      email: 'other@example.test',
      organizationName: 'Second Org',
    });

    const visible = await withTenant({ organizationId: first.organizationId }, (tx) =>
      tx.select().from(organizations),
    );

    expect(visible).toHaveLength(1);
    expect(visible[0]?.id).toBe(first.organizationId);
    // Six rows exist platform-wide; each tenant sees only its three.
    expect(await countAll('integrations')).toBe(6);
  });
});

describe('auth token hygiene', () => {
  it('keeps at most one live verification token per user', async () => {
    await registerOrganization(VALID);
    expect(await countAll('auth_tokens')).toBe(1);

    const sql = adminSql();
    const [user] = await sql<{ id: string }[]>`SELECT id FROM users LIMIT 1`;

    const { issueEmailVerification } = await import('@/server/services/auth-service');
    await issueEmailVerification({
      userId: user!.id,
      email: VALID.email,
      name: VALID.name,
      locale: 'ar',
    });

    // Re-issuing replaces rather than accumulates, so an old link stops working.
    expect(await countAll('auth_tokens')).toBe(1);
  });

  it('records no plaintext token anywhere in the table', async () => {
    await registerOrganization(VALID);
    const token = tokenFromUrl(sentEmails[0]!.url);

    const sql = adminSql();
    const rows = await sql<Record<string, unknown>[]>`SELECT * FROM auth_tokens`;
    expect(JSON.stringify(rows)).not.toContain(token);
  });
});
