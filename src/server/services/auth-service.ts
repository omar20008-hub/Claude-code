import { createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
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
import { secureToken } from '@/lib/ids';
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

async function uniqueSlug(candidate: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = attempt === 0 ? candidate : `${candidate}-${secureToken(3).toLowerCase()}`;
    const existing = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .limit(1);
    if (existing.length === 0) return slug;
  }
  return `${candidate}-${secureToken(6).toLowerCase()}`;
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

  const existing = await withoutTenantScope('auth:lookup-user-by-email', (tx) =>
    tx
      .select({ id: users.id })
      .from(users)
      .where(eq(sql`lower(${users.email})`, email))
      .limit(1),
  );

  if (existing.length > 0) {
    // Registration necessarily reveals whether an address is taken — there is
    // no way to create an account at a colliding address. Login and password
    // reset, where enumeration actually matters, stay silent.
    throw new AppError('email_already_registered');
  }

  const passwordHash = await hashPassword(input.password);
  const slug = await uniqueSlug(slugify(input.organizationName));

  const created = await db.transaction(async (tx) => {
    const [organization] = await tx
      .insert(organizations)
      .values({
        name: input.organizationName.trim(),
        slug,
        defaultLocale: input.locale,
        timezone: META_CONFIG.timezone,
        currency: META_CONFIG.currency,
      })
      .returning({ id: organizations.id });

    if (!organization) {
      throw new AppError('internal_error', {
        internalMessage: 'organization insert returned no row',
      });
    }

    const [user] = await tx
      .insert(users)
      .values({
        organizationId: organization.id,
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
        organizationId: organization.id,
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
        organizationId: organization.id,
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
        organizationId: organization.id,
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
      organizationId: organization.id,
      kind: 'GOOGLE_DRIVE',
      externalId: KNOWLEDGE_DRIVE_FOLDER_ID,
      displayName: KNOWLEDGE_DRIVE_FOLDER_NAME,
      supportedFormats: [...KNOWLEDGE_SUPPORTED_MIME_TYPES],
    });

    return { organizationId: organization.id, userId: user.id };
  });

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
    metadata: { organizationName: input.organizationName, slug },
  });

  return { ...created, email };
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

  const result = await withoutTenantScope('auth:redeem-token', async (tx) => {
    const rows = await tx
      .select({
        tokenId: authTokens.id,
        userId: authTokens.userId,
        expiresAt: authTokens.expiresAt,
        consumedAt: authTokens.consumedAt,
        organizationId: users.organizationId,
        email: users.email,
      })
      .from(authTokens)
      .innerJoin(users, eq(users.id, authTokens.userId))
      .where(
        and(eq(authTokens.tokenHash, tokenHash), eq(authTokens.purpose, 'EMAIL_VERIFICATION')),
      )
      .limit(1);

    const row = rows[0];
    if (!row) throw new AppError('invalid_token');
    if (row.consumedAt) throw new AppError('invalid_token');
    if (row.expiresAt.getTime() < Date.now()) throw new AppError('token_expired');

    await tx
      .update(authTokens)
      .set({ consumedAt: new Date() })
      .where(eq(authTokens.id, row.tokenId));

    await tx
      .update(users)
      .set({
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(users.id, row.userId));

    return { organizationId: row.organizationId, userId: row.userId, email: row.email };
  });

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

  const rows = await withoutTenantScope('auth:lookup-user-by-email', (tx) =>
    tx
      .select({
        id: users.id,
        organizationId: users.organizationId,
        passwordHash: users.passwordHash,
        status: users.status,
        localePreference: users.localePreference,
        failedLoginCount: users.failedLoginCount,
        lockedUntil: users.lockedUntil,
        deletedAt: users.deletedAt,
        organizationLocale: organizations.defaultLocale,
        organizationDeletedAt: organizations.deletedAt,
      })
      .from(users)
      .innerJoin(organizations, eq(organizations.id, users.organizationId))
      .where(eq(sql`lower(${users.email})`, email))
      .limit(1),
  );

  const user = rows[0];

  if (!user || user.deletedAt || user.organizationDeletedAt) {
    await fakeVerify();
    throw new AppError('invalid_credentials');
  }

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

    await withoutTenantScope('auth:lookup-user-by-email', (tx) =>
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

  await withoutTenantScope('auth:lookup-user-by-email', (tx) =>
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

  const rows = await withoutTenantScope('auth:lookup-user-by-email', (tx) =>
    tx
      .select({
        id: users.id,
        name: users.name,
        organizationId: users.organizationId,
        localePreference: users.localePreference,
      })
      .from(users)
      .where(and(eq(sql`lower(${users.email})`, email), isNull(users.deletedAt)))
      .limit(1),
  );

  const user = rows[0];
  if (!user) return;

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

  const result = await withoutTenantScope('auth:redeem-token', async (tx) => {
    const rows = await tx
      .select({
        tokenId: authTokens.id,
        userId: authTokens.userId,
        expiresAt: authTokens.expiresAt,
        consumedAt: authTokens.consumedAt,
        organizationId: users.organizationId,
        email: users.email,
      })
      .from(authTokens)
      .innerJoin(users, eq(users.id, authTokens.userId))
      .where(and(eq(authTokens.tokenHash, tokenHash), eq(authTokens.purpose, 'PASSWORD_RESET')))
      .limit(1);

    const row = rows[0];
    if (!row) throw new AppError('invalid_token');
    if (row.consumedAt) throw new AppError('invalid_token');
    if (row.expiresAt.getTime() < Date.now()) throw new AppError('token_expired');

    await tx
      .update(authTokens)
      .set({ consumedAt: new Date() })
      .where(eq(authTokens.id, row.tokenId));

    await tx
      .update(users)
      .set({
        passwordHash,
        failedLoginCount: 0,
        lockedUntil: null,
        // Completing a reset proves control of the mailbox, so an account still
        // pending verification becomes active here.
        status: 'ACTIVE',
        emailVerifiedAt: sql`COALESCE(${users.emailVerifiedAt}, now())`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, row.userId));

    return row;
  });

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
