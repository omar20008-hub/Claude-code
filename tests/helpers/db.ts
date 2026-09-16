import postgres from 'postgres';
import { randomUUID } from 'node:crypto';

/**
 * Integration-test database helpers.
 *
 * The tests connect through the application's own `db` client, which points at
 * DATABASE_URL. In the test environment that URL is the least-privilege
 * `app_user` role — NOT a superuser — because Postgres exempts superusers and
 * BYPASSRLS roles from row-level security. Running these tests as `postgres`
 * would make every isolation assertion pass without proving anything.
 *
 * A second, privileged connection exists purely for fixtures and truncation:
 * app_user has no TRUNCATE privilege, and `audit_logs` rejects DELETE outright.
 */

const ADMIN_URL =
  process.env.TEST_ADMIN_DATABASE_URL ??
  'postgres://postgres@127.0.0.1:5432/ai_workforce_test';

let admin: postgres.Sql | undefined;

export function adminSql(): postgres.Sql {
  admin ??= postgres(ADMIN_URL, { max: 2, onnotice: () => {} });
  return admin;
}

/** Tables cleared between suites, ordered so FK cascades do the rest. */
const TRUNCATE_TABLES = [
  'organizations',
  'rate_limits',
  'system_events',
  'webhook_deliveries',
] as const;

/**
 * Resets the database to empty.
 *
 * The append-only triggers on audit_logs and usage_records must be disabled for
 * the truncate; they are re-enabled immediately. This is the one sanctioned
 * place that happens, and it runs on the admin connection only — the
 * application role cannot do it, which is the point.
 */
export async function resetDatabase(): Promise<void> {
  const sql = adminSql();
  await sql.unsafe(`
    SET session_replication_role = 'replica';
    TRUNCATE ${TRUNCATE_TABLES.join(', ')} RESTART IDENTITY CASCADE;
    SET session_replication_role = 'origin';
  `);
}

export async function closeDatabase(): Promise<void> {
  if (admin) {
    await admin.end({ timeout: 5 });
    admin = undefined;
  }
  const { sql } = await import('@/server/db/client');
  await sql.end({ timeout: 5 });
}

export interface SeededTenant {
  organizationId: string;
  userId: string;
  email: string;
  slug: string;
}

/**
 * Creates a tenant directly, bypassing the registration flow.
 *
 * Uses the admin connection deliberately: seeding through `withTenant` would
 * make a fixture failure look like an isolation failure.
 */
export async function seedTenant(
  overrides: Partial<{
    name: string;
    slug: string;
    email: string;
    locale: 'ar' | 'en';
    status: 'ACTIVE' | 'PENDING_VERIFICATION';
  }> = {},
): Promise<SeededTenant> {
  const sql = adminSql();
  const suffix = randomUUID().slice(0, 8);
  const name = overrides.name ?? `Tenant ${suffix}`;
  const slug = overrides.slug ?? `tenant-${suffix}`;
  const email = overrides.email ?? `admin-${suffix}@example.test`;
  const locale = overrides.locale ?? 'en';
  const status = overrides.status ?? 'ACTIVE';

  const [organization] = await sql<{ id: string }[]>`
    INSERT INTO organizations (name, slug, default_locale)
    VALUES (${name}, ${slug}, ${locale}::locale)
    RETURNING id
  `;

  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (organization_id, email, password_hash, name, role, status, locale_preference, email_verified_at)
    VALUES (
      ${organization!.id},
      ${email},
      ${'scrypt$131072$8$1$c2FsdHNhbHRzYWx0c2E=$ZmFrZWhhc2hmb3J0ZXN0aW5nb25seQ=='},
      ${`Admin ${suffix}`},
      'ADMIN',
      ${status}::user_status,
      ${locale}::locale,
      now()
    )
    RETURNING id
  `;

  return { organizationId: organization!.id, userId: user!.id, email, slug };
}

/** Counts rows in a table on the privileged connection, ignoring RLS. */
export async function countAll(table: string): Promise<number> {
  const sql = adminSql();
  const rows = await sql.unsafe<{ count: string }[]>(`SELECT count(*)::text AS count FROM ${table}`);
  return Number(rows[0]?.count ?? 0);
}
