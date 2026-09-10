import { createHash } from 'node:crypto';
import { and, eq, sql, sql as rawSql } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { withoutTenantScope, withTenant } from '@/server/tenancy/context';
import {
  organizations,
  users,
  authTokens,
  knowledgeSources,
  integrations,
} from '@/server/db/schema';
import {
  hashPassword,
  verifyPassword,
  needsRehash,
  fakeVerify,
  validatePasswordStrength,
  PASSWORD_MIN_LENGTH,
} from '@/server/auth/password';
import { createSession, revokeAllSessions } from '@/server/auth/session';
import { secureToken, uuid } from '@/lib/ids';
import { AppError } from '@/lib/errors';
import { recordAudit } from './audit';
import { sendEmail } from './email';
import { env } from '@/server/config/env';
import type { Locale } from '@/i18n/config';
import {
  KNOWLEDGE_DRIVE_FOLDER_ID,
  KNOWLEDGE_DRIVE_FOLDER_NAME,
  KNOWLEDGE_SUPPORTED_MIME_TYPES,
} from '@/server/agents/adapters/knowledge';
import { META_CONFIG } from '@/server/agents/adapters/advertising';

/**
 * Authentication and organization provisioning (§11).
 */

const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

/** Progressive lockout thresholds. */
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

function hashTokenValue(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** postgres.js returns an array; drizzle's execute may wrap it in `.rows`. */
function firstRow<T>(result: unknown): T | undefined {
  if (Array.isArray(result)) return result[0] as T | undefined;
  return ((result as { rows?: unknown[] }).rows?.[0] as T | undefined) ?? undefined;
}

/**
 * The authentication path cannot be tenant-scoped: it is what determines the
 * tenant. These helpers wrap the SECURITY DEFINER functions created in
 * drizzle/0002_auth_path.sql, which confine that necessary bypass to a few
 * narrow, reviewable signatures instead of granting the app role BYPASSRLS.
 * See that migration's header for the full reasoning.
 */
interface AuthUserRow {
  id: string;
  organization_id: string;
  password_hash: string;
  name: string;
  status: string;
  locale_preference: string | null;
  failed_login_count: number;
  locked_until: Date | string | null;
  deleted_at: Date | string | null;
  organization_locale: string;
  organization_deleted_at: Date | string | null;
}

async function lookupUserByEmail(email: string): Promise<AuthUserRow | undefined> {
  const result = await db.execute(
    rawSql`SELECT * FROM auth_lookup_user_by_email(${email})`,
  );
  return firstRow<AuthUserRow>(result);
}

interface AuthUserByIdRow {
  id: string;
  organization_id: string;
  email: string;
  name: string;
  status: string;
  locale_preference: string | null;
}

async function lookupUserById(userId: string): Promise<AuthUserByIdRow | undefined> {
  const result = await db.execute(
    rawSql`SELECT * FROM auth_lookup_user_by_id(${userId}::uuid)`,
  );
  return firstRow<AuthUserByIdRow>(result);
}

async function emailExists(email: string): Promise<boolean> {
  const result = await db.execute(
    rawSql`SELECT auth_email_exists(${email}) AS exists`,
  );
  return Boolean(firstRow<{ exists: boolean }>(result)?.exists);
}

/** URL-safe tenant handle derived from the organization name. */
function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    // Keep Arabic letters: an organization named "شركة النور" should not
    // slugify to an empty string and fall back to a random suffix alone.
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 40);

  return base.length > 0 ? base : 'org';
}

/**
 * Finds an unused slug.
 *
 * Cannot SELECT from `organizations` to check: that read is unscoped by nature
 * (we are looking across all tenants) and RLS correctly returns nothing, which
 * would make every slug look free. So uniqueness is left to the unique index
 * and collisions are avoided by construction — a random suffix after the first
 * attempt. The insert below retries on a conflict.
 */
function candidateSlugs(base: string): string[] {
  return [
    base,
    ...Array.from({ length: 4 }, () => `${base}-${secureToken(3).toLowerCase()}`),
  ];
}

export interface RegisterInput {
  organizationName: string;
  name: string;
  email: string;
  password: string;
  locale: Locale;
  ipAddress?: string;
  userAgent?: string;
  correlationId: string;
}

export interface RegisterResult {
  organizationId: string;
  userId: string;
  email: string;
}

/**
 * Creates an organization and its first administrator.
 *
 * Everything happens in one transaction: a half-created tenant with a user but
 * no organization, or an organization nobody can sign into, is worse than a
 * clean failure.
 */
export async function registerOrganization(input: RegisterInput): Promise<RegisterResult> {
  const email = normalizeEmail(input.email);

  const passwordFailures = validatePasswordStrength(input.password);
  if (passwordFailures.length > 0) {
    throw new AppError('validation_failed', {
      fields: passwordFailures.map((rule) => ({
        path: 'password',
        rule,
        params: { min: PASSWORD_MIN_LENGTH },
      })),
    });
  }

  if (await emailExists(email)) {
    // Registration necessarily reveals whether an address is taken — there is
    // no way to create an account at a colliding address. Login and password
    // reset, where enumeration actually matters, stay silent.
    throw new AppError('email_already_registered');
  }

  const passwordHash = await hashPassword(input.password);

  /*
   * Bootstrapping a tenant under RLS.
   *
   * The organization's UUID is generated here, in the application, so the
   * transaction can pin `app.organization_id` to it BEFORE inserting. The
   * policy's WITH CHECK (id = app_current_organization_id()) then passes
   * normally, and every dependent insert in the same transaction is already
   * correctly scoped.
   *
   * Doing it the other way round — insert first, learn the id after — is what
   * fails: an unscoped INSERT into a FORCE'd RLS table is rejected, which is
   * exactly what the policy is supposed to do.
   */
  const organizationId = uuid();
  const slugs = candidateSlugs(slugify(input.organizationName));
  let created: { organizationId: string; userId: string } | undefined;
  let lastError: unknown;

  for (const slug of slugs) {
    try {
      created = await withTenant({ organizationId }, async (tx) => {
        await tx.insert(organizations).values({
          id: organizationId,
          name: input.organizationName.trim(),
          slug,
          defaultLocale: input.locale,
          timezone: META_CONFIG.timezone,
          currency: META_CONFIG.currency,
        });

        return insertTenantContents(tx, organizationId, input, passwordHash);
      });
      break;
    } catch (error) {
      // A slug collision is expected and retried; anything else is real.
      if (!isSlugConflict(error)) throw error;
      lastError = error;
    }
  }

  if (!created) {
    throw new AppError('internal_error', {
      internalMessage: 'Could not allocate a unique organization slug',
      cause: lastError,
    });
  }

  await issueEmailVerification({
    userId: created.userId,
    email,
    name: input.name,
    locale: input.locale,
  });

  await recordAudit({
    organizationId: created.organizationId,
    userId: created.userId,
    actorEmail: email,
    action: 'auth.register',
    resourceType: 'organization',
    resourceId: created.organizationId,
    status: 'SUCCESS',
    correlationId: input.correlationId,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
    metadata: { organizationName: input.organizationName },
  });

  return { ...created, email };
}

/** True for a unique-violation on the organizations slug index. */
function isSlugConflict(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const record = current as { code?: unknown; constraint_name?: unknown };
    if (record.code === '23505' && String(record.constraint_name ?? '').includes('slug')) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Creates the admin user and the tenant's starting rows. */
async function insertTenantContents(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  organizationId: string,
  input: RegisterInput,
  passwordHash: string,
): Promise<{ organizationId: string; userId: string }> {
  {
    const email = normalizeEmail(input.email);
    const [user] = await tx
      .insert(users)
      .values({
        organizationId,
        email,
        passwordHash,
        name: input.name.trim(),
        role: 'ADMIN',
        status: 'PENDING_VERIFICATION',
        localePreference: input.locale,
      })
      .returning({ id: users.id });

    if (!user) {
      throw new AppError('internal_error', {
        internalMessage: 'user insert returned no row',
      });
    }

    // Seed the integration rows so Settings can show accurate, honest status
    // from the first page load rather than an empty screen. Everything starts
    // NOT_CONFIGURED and is only promoted by a real check.
    await tx.insert(integrations).values([
      {
        organizationId,
        kind: 'GOOGLE_DRIVE',
        status: 'NOT_CONFIGURED',
        metadata: {
          folderId: KNOWLEDGE_DRIVE_FOLDER_ID,
          folderName: KNOWLEDGE_DRIVE_FOLDER_NAME,
          // Credentials live in n8n, not here — recorded so the UI can say so.
          credentialOwner: 'n8n',
        },
      },
      {
        organizationId,
        kind: 'META_ADS',
        status: 'NOT_CONFIGURED',
        metadata: {
          adAccountId: META_CONFIG.adAccountId,
          pageId: META_CONFIG.pageId,
          apiVersion: META_CONFIG.apiVersion,
          credentialOwner: 'n8n',
        },
      },
      {
        organizationId,
        kind: 'N8N',
        status: env().N8N_BASE_URL ? 'CONNECTED' : 'NOT_CONFIGURED',
        metadata: {
          workflows: {
            knowledge: env().N8N_KNOWLEDGE_WORKFLOW_ID,
            creative: env().N8N_CREATIVE_WORKFLOW_ID,
            advertising: env().N8N_ADVERTISING_WORKFLOW_ID,
          },
        },
      },
    ]);

    await tx.insert(knowledgeSources).values({
      organizationId,
      kind: 'GOOGLE_DRIVE',
      externalId: KNOWLEDGE_DRIVE_FOLDER_ID,
      displayName: KNOWLEDGE_DRIVE_FOLDER_NAME,
      supportedFormats: [...KNOWLEDGE_SUPPORTED_MIME_TYPES],
    });

    return { organizationId, userId: user.id };
  }
}

/** Creates a verification token and mails the link. */
export async function issueEmailVerification(params: {
  userId: string;
  email: string;
  name: string;
  locale: Locale;
}): Promise<void> {
  const token = secureToken(32);

  await withoutTenantScope('auth:redeem-token', async (tx) => {
    // One live verification token per user: issuing a new one invalidates any
    // previous link.
    await tx
      .delete(authTokens)
      .where(
        and(
          eq(authTokens.userId, params.userId),
          eq(authTokens.purpose, 'EMAIL_VERIFICATION'),
        ),
      );

    await tx.insert(authTokens).values({
      userId: params.userId,
      purpose: 'EMAIL_VERIFICATION',
      tokenHash: hashTokenValue(token),
      expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
    });
  });

  await sendEmail({
    to: params.email,
    locale: params.locale,
    template: 'verify-email',
    params: {
      name: params.name,
      url: `${env().APP_URL}/${params.locale}/verify-email?token=${token}`,
    },
  });
}

/** Redeems a verification token, activating the account. */
export async function verifyEmail(token: string): Promise<{ organizationId: string }> {
  const tokenHash = hashTokenValue(token);

  // auth_tokens carries no tenant content and is deliberately not RLS-protected
  // (see drizzle/0001_rls.sql), so this read runs unscoped by design.
  const token_row = await withoutTenantScope('auth:redeem-token', async (tx) => {
    const rows = await tx
      .select({
        tokenId: authTokens.id,
        userId: authTokens.userId,
        expiresAt: authTokens.expiresAt,
        consumedAt: authTokens.consumedAt,
      })
      .from(authTokens)
      .where(
        and(eq(authTokens.tokenHash, tokenHash), eq(authTokens.purpose, 'EMAIL_VERIFICATION')),
      )
      .limit(1);

    const row = rows[0];
    if (!row) throw new AppError('invalid_token');
    if (row.consumedAt) throw new AppError('invalid_token');
    if (row.expiresAt.getTime() < Date.now()) throw new AppError('token_expired');
    return row;
  });

  // The token yields a user but not a tenant; resolve it so the write below is
  // an ordinary scoped update rather than an RLS bypass.
  const user = await lookupUserById(token_row.userId);
  if (!user) throw new AppError('invalid_token');

  const result = await withTenant(
    { organizationId: user.organization_id, userId: user.id },
    async (tx) => {
      await tx
        .update(users)
        .set({ status: 'ACTIVE', emailVerifiedAt: new Date(), updatedAt: new Date() })
        .where(eq(users.id, user.id));
      return { organizationId: user.organization_id, userId: user.id, email: user.email };
    },
  );

  // Consumed only after the activation committed, so a failure leaves the link
  // usable rather than burning it.
  await withoutTenantScope('auth:redeem-token', (tx) =>
    tx
      .update(authTokens)
      .set({ consumedAt: new Date() })
      .where(eq(authTokens.id, token_row.tokenId)),
  );

  await recordAudit({
    organizationId: result.organizationId,
    userId: result.userId,
    actorEmail: result.email,
    action: 'auth.email_verified',
    resourceType: 'user',
    resourceId: result.userId,
    status: 'SUCCESS',
  });

  return { organizationId: result.organizationId };
}

export interface LoginInput {
  email: string;
  password: string;
  ipAddress?: string;
  userAgent?: string;
  correlationId: string;
}

/**
 * Authenticates a user and opens a session.
 *
 * Enumeration resistance is the design constraint: a wrong password, an unknown
 * address, and a soft-deleted account all produce the same `invalid_credentials`
 * error after comparable work. `fakeVerify()` burns an equivalent scrypt cost on
 * the unknown-address path so response timing does not distinguish them.
 */
export async function login(input: LoginInput): Promise<{
  userId: string;
  organizationId: string;
  locale: Locale;
}> {
  const email = normalizeEmail(input.email);

  const found = await lookupUserByEmail(email);

  if (!found || found.deleted_at || found.organization_deleted_at) {
    // Burns comparable CPU so "no such account" and "wrong password" take
    // indistinguishable time; response latency must not be an oracle.
    await fakeVerify();
    throw new AppError('invalid_credentials');
  }

  const user = {
    id: found.id,
    organizationId: found.organization_id,
    passwordHash: found.password_hash,
    status: found.status,
    localePreference: found.locale_preference,
    failedLoginCount: found.failed_login_count,
    lockedUntil: found.locked_until ? new Date(found.locked_until) : null,
    organizationLocale: found.organization_locale,
  };

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
    await recordAudit({
      organizationId: user.organizationId,
      userId: user.id,
      actorEmail: email,
      action: 'auth.login_failed',
      resourceType: 'user',
      resourceId: user.id,
      status: 'FAILURE',
      correlationId: input.correlationId,
      ipAddress: input.ipAddress,
      metadata: { reason: 'account_locked' },
    });
    throw new AppError('account_locked', { params: { minutes } });
  }

  const passwordOk = await verifyPassword(input.password, user.passwordHash);

  if (!passwordOk) {
    const nextCount = user.failedLoginCount + 1;
    const shouldLock = nextCount >= LOCKOUT_THRESHOLD;

    // The tenant is known now, so this is an ordinary scoped write.
    await withTenant({ organizationId: user.organizationId }, (tx) =>
      tx
        .update(users)
        .set({
          failedLoginCount: nextCount,
          lockedUntil: shouldLock ? new Date(Date.now() + LOCKOUT_DURATION_MS) : null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id)),
    );

    await recordAudit({
      organizationId: user.organizationId,
      userId: user.id,
      actorEmail: email,
      action: 'auth.login_failed',
      resourceType: 'user',
      resourceId: user.id,
      status: 'FAILURE',
      correlationId: input.correlationId,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      metadata: { attempt: nextCount, locked: shouldLock },
    });

    throw new AppError('invalid_credentials');
  }

  if (user.status === 'PENDING_VERIFICATION') {
    throw new AppError('email_not_verified');
  }
  if (user.status === 'SUSPENDED') {
    throw new AppError('forbidden', { internalMessage: 'Account suspended' });
  }

  // Successful authentication: clear the lockout counters and, if the stored
  // hash predates a cost increase, upgrade it transparently.
  const updates: Record<string, unknown> = {
    failedLoginCount: 0,
    lockedUntil: null,
    lastLoginAt: new Date(),
    updatedAt: new Date(),
  };
  if (needsRehash(user.passwordHash)) {
    updates.passwordHash = await hashPassword(input.password);
  }

  await withTenant({ organizationId: user.organizationId, userId: user.id }, (tx) =>
    tx.update(users).set(updates).where(eq(users.id, user.id)),
  );

  await createSession({
    userId: user.id,
    organizationId: user.organizationId,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

  await recordAudit({
    organizationId: user.organizationId,
    userId: user.id,
    actorEmail: email,
    action: 'auth.login',
    resourceType: 'user',
    resourceId: user.id,
    status: 'SUCCESS',
    correlationId: input.correlationId,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

  return {
    userId: user.id,
    organizationId: user.organizationId,
    locale: (user.localePreference ?? user.organizationLocale) as Locale,
  };
}

/**
 * Starts a password reset.
 *
 * Always resolves successfully, whether or not the address exists. The caller
 * shows "if an account exists, a link is on its way" — the only way this
 * endpoint does not become an account-enumeration oracle.
 */
export async function requestPasswordReset(params: {
  email: string;
  locale: Locale;
  correlationId: string;
  ipAddress?: string;
}): Promise<void> {
  const email = normalizeEmail(params.email);

  const found = await lookupUserByEmail(email);
  // Returns silently for an unknown or deleted account: this endpoint must not
  // become an account-enumeration oracle.
  if (!found || found.deleted_at) return;

  const user = {
    id: found.id,
    name: found.name,
    organizationId: found.organization_id,
    localePreference: found.locale_preference,
  };

  const token = secureToken(32);

  await withoutTenantScope('auth:redeem-token', async (tx) => {
    await tx
      .delete(authTokens)
      .where(and(eq(authTokens.userId, user.id), eq(authTokens.purpose, 'PASSWORD_RESET')));

    await tx.insert(authTokens).values({
      userId: user.id,
      purpose: 'PASSWORD_RESET',
      tokenHash: hashTokenValue(token),
      expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
    });
  });

  const locale = (user.localePreference ?? params.locale) as Locale;

  await sendEmail({
    to: email,
    locale,
    template: 'reset-password',
    params: {
      name: user.name,
      url: `${env().APP_URL}/${locale}/reset-password?token=${token}`,
    },
  });

  await recordAudit({
    organizationId: user.organizationId,
    userId: user.id,
    actorEmail: email,
    action: 'auth.password_reset_requested',
    resourceType: 'user',
    resourceId: user.id,
    status: 'SUCCESS',
    correlationId: params.correlationId,
    ipAddress: params.ipAddress,
  });
}

/** Redeems a reset token and sets a new password. */
export async function resetPassword(params: {
  token: string;
  newPassword: string;
  correlationId: string;
  ipAddress?: string;
}): Promise<void> {
  const failures = validatePasswordStrength(params.newPassword);
  if (failures.length > 0) {
    throw new AppError('validation_failed', {
      fields: failures.map((rule) => ({
        path: 'newPassword',
        rule,
        params: { min: PASSWORD_MIN_LENGTH },
      })),
    });
  }

  const tokenHash = hashTokenValue(params.token);
  const passwordHash = await hashPassword(params.newPassword);

  const tokenRow = await withoutTenantScope('auth:redeem-token', async (tx) => {
    const rows = await tx
      .select({
        tokenId: authTokens.id,
        userId: authTokens.userId,
        expiresAt: authTokens.expiresAt,
        consumedAt: authTokens.consumedAt,
      })
      .from(authTokens)
      .where(and(eq(authTokens.tokenHash, tokenHash), eq(authTokens.purpose, 'PASSWORD_RESET')))
      .limit(1);

    const row = rows[0];
    if (!row) throw new AppError('invalid_token');
    if (row.consumedAt) throw new AppError('invalid_token');
    if (row.expiresAt.getTime() < Date.now()) throw new AppError('token_expired');
    return row;
  });

  const user = await lookupUserById(tokenRow.userId);
  if (!user) throw new AppError('invalid_token');

  const result = await withTenant(
    { organizationId: user.organization_id, userId: user.id },
    async (tx) => {
      await tx
        .update(users)
        .set({
          passwordHash,
          failedLoginCount: 0,
          lockedUntil: null,
          // Completing a reset proves control of the mailbox, so an account
          // still pending verification becomes active here.
          status: 'ACTIVE',
          emailVerifiedAt: sql`COALESCE(${users.emailVerifiedAt}, now())`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id));

      return { userId: user.id, organizationId: user.organization_id, email: user.email };
    },
  );

  await withoutTenantScope('auth:redeem-token', (tx) =>
    tx
      .update(authTokens)
      .set({ consumedAt: new Date() })
      .where(eq(authTokens.id, tokenRow.tokenId)),
  );

  // An attacker holding a stolen session must lose it when the owner recovers
  // the account.
  await revokeAllSessions(result.userId);

  await recordAudit({
    organizationId: result.organizationId,
    userId: result.userId,
    actorEmail: result.email,
    action: 'auth.password_reset',
    resourceType: 'user',
    resourceId: result.userId,
    status: 'SUCCESS',
    correlationId: params.correlationId,
    ipAddress: params.ipAddress,
  });
}

/** Changes a password for a signed-in user, verifying the current one first. */
export async function changePassword(params: {
  userId: string;
  organizationId: string;
  currentPassword: string;
  newPassword: string;
  correlationId: string;
}): Promise<void> {
  const failures = validatePasswordStrength(params.newPassword);
  if (failures.length > 0) {
    throw new AppError('validation_failed', {
      fields: failures.map((rule) => ({
        path: 'newPassword',
        rule,
        params: { min: PASSWORD_MIN_LENGTH },
      })),
    });
  }

  const rows = await withTenant({ organizationId: params.organizationId }, (tx) =>
    tx
      .select({ passwordHash: users.passwordHash, email: users.email })
      .from(users)
      .where(eq(users.id, params.userId))
      .limit(1),
  );

  const user = rows[0];
  if (!user) throw new AppError('not_found');

  if (!(await verifyPassword(params.currentPassword, user.passwordHash))) {
    throw new AppError('validation_failed', {
      fields: [{ path: 'currentPassword', rule: 'invalid' }],
    });
  }

  const passwordHash = await hashPassword(params.newPassword);

  await withTenant({ organizationId: params.organizationId }, (tx) =>
    tx
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, params.userId)),
  );

  await revokeAllSessions(params.userId);

  await recordAudit({
    organizationId: params.organizationId,
    userId: params.userId,
    actorEmail: user.email,
    action: 'auth.password_reset',
    resourceType: 'user',
    resourceId: params.userId,
    status: 'SUCCESS',
    correlationId: params.correlationId,
    metadata: { method: 'change_password' },
  });
}
