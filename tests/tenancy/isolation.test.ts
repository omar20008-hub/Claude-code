import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq, getTableName, sql as rawSql } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { withTenant, withoutTenantScope } from '@/server/tenancy/context';
import {
  campaigns,
  assets,
  conversations,
  messages,
  agentRequests,
  auditLogs,
  notifications,
  organizations,
  tenantScopedTables,
} from '@/server/db/schema';
import { resetDatabase, seedTenant, closeDatabase, adminSql, countAll } from '../helpers/db';
import { captureRejection, databaseErrorMessage, pgErrorCode } from '../helpers/errors';

/**
 * Multi-tenancy isolation suite (§9, §50).
 *
 * These tests run as the `app_user` role, which has neither SUPERUSER nor
 * BYPASSRLS. That matters more than anything else in this file: Postgres
 * exempts those roles from row-level security, so the same assertions run as
 * `postgres` would pass against a database with no policies at all.
 *
 * The first test proves the harness itself is honest before the rest rely on it.
 */

let tenantA: Awaited<ReturnType<typeof seedTenant>>;
let tenantB: Awaited<ReturnType<typeof seedTenant>>;

beforeAll(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  tenantA = await seedTenant({ name: 'Tenant A', locale: 'ar' });
  tenantB = await seedTenant({ name: 'Tenant B', locale: 'en' });
});

/** Inserts one row per tenant-owned table, on the privileged connection. */
async function seedCrossTenantFixtures(): Promise<void> {
  const sql = adminSql();

  for (const tenant of [tenantA, tenantB]) {
    const label = tenant.slug;

    await sql`
      INSERT INTO campaigns (organization_id, name, locale, status)
      VALUES (${tenant.organizationId}, ${`${label} campaign`}, 'en', 'DRAFT')
    `;
    await sql`
      INSERT INTO assets (organization_id, kind, status, title)
      VALUES (${tenant.organizationId}, 'IMAGE', 'STORED', ${`${label} asset`})
    `;
    const [conversation] = await sql<{ id: string }[]>`
      INSERT INTO conversations (organization_id, user_id, agent, title, agent_session_id, locale)
      VALUES (
        ${tenant.organizationId}, ${tenant.userId}, 'KNOWLEDGE_AGENT',
        ${`${label} conversation`}, ${`sess-${label}`}, 'en'
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO messages (organization_id, conversation_id, role, content)
      VALUES (${tenant.organizationId}, ${conversation!.id}, 'USER', ${`${label} secret message`})
    `;
    await sql`
      INSERT INTO agent_requests (organization_id, user_id, request_ref, correlation_id, agent, action, locale)
      VALUES (
        ${tenant.organizationId}, ${tenant.userId}, ${`req_${label}`}, ${`cid_${label}`},
        'KNOWLEDGE_AGENT', 'knowledge.ask', 'en'
      )
    `;
    await sql`
      INSERT INTO audit_logs (organization_id, user_id, action, resource_type, status)
      VALUES (${tenant.organizationId}, ${tenant.userId}, 'auth.login', 'user', 'SUCCESS')
    `;
    await sql`
      INSERT INTO notifications (organization_id, user_id, kind, message_key)
      VALUES (${tenant.organizationId}, ${tenant.userId}, 'ASSET_READY', 'notifications.messages.assetReady')
    `;
  }
}

describe('multi-tenancy isolation', () => {
  it('runs as a role that row-level security actually applies to', async () => {
    // Guard test: if this fails, every other assertion in this file is vacuous.
    const rows = await db.execute<{
      current_user: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(rawSql`
      SELECT current_user,
             (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS rolsuper,
             (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS rolbypassrls
    `);

    const row = (Array.isArray(rows) ? rows[0] : rows) as {
      current_user: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    };

    expect(row.rolsuper, 'tests must not run as a superuser').toBe(false);
    expect(row.rolbypassrls, 'tests must not run with BYPASSRLS').toBe(false);
  });

  it('declares organization_id on every table listed as tenant-scoped', async () => {
    const sql = adminSql();
    const missing: string[] = [];

    for (const table of tenantScopedTables) {
      const name = getTableName(table);
      const rows = await sql<{ exists: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = ${name}
            AND column_name = 'organization_id'
            AND is_nullable = 'NO'
        ) AS exists
      `;
      if (!rows[0]?.exists) missing.push(name);
    }

    expect(missing, 'tables missing a NOT NULL organization_id').toEqual([]);
  });

  it('enables and forces row-level security on every tenant table', async () => {
    const sql = adminSql();
    const unprotected: string[] = [];

    for (const table of tenantScopedTables) {
      const name = getTableName(table);
      const rows = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        SELECT relrowsecurity, relforcerowsecurity
        FROM pg_class
        WHERE oid = ${`public.${name}`}::regclass
      `;
      const row = rows[0];
      if (!row?.relrowsecurity || !row?.relforcerowsecurity) unprotected.push(name);
    }

    expect(unprotected, 'tables without FORCE ROW LEVEL SECURITY').toEqual([]);
  });

  it('shows a tenant only its own rows, across every content table', async () => {
    await seedCrossTenantFixtures();

    // Both tenants really do have data.
    expect(await countAll('campaigns')).toBe(2);
    expect(await countAll('messages')).toBe(2);

    const visible = await withTenant({ organizationId: tenantA.organizationId }, async (tx) => ({
      campaigns: await tx.select().from(campaigns),
      assets: await tx.select().from(assets),
      conversations: await tx.select().from(conversations),
      messages: await tx.select().from(messages),
      agentRequests: await tx.select().from(agentRequests),
      auditLogs: await tx.select().from(auditLogs),
      notifications: await tx.select().from(notifications),
      organizations: await tx.select().from(organizations),
    }));

    for (const [table, rows] of Object.entries(visible)) {
      expect(rows.length, `${table} should expose exactly one row to tenant A`).toBe(1);
      for (const row of rows as Array<Record<string, unknown>>) {
        const owner = row.organizationId ?? row.id;
        expect(owner, `${table} row leaked from another tenant`).toBe(tenantA.organizationId);
      }
    }

    // And none of tenant B's content is reachable by content, not just by count.
    expect(visible.messages[0]?.content).toContain(tenantA.slug);
    expect(visible.campaigns[0]?.name).not.toContain(tenantB.slug);
  });

  it('returns nothing at all when no tenant scope is set (fail-closed)', async () => {
    await seedCrossTenantFixtures();

    // `withoutTenantScope` opens a transaction without SET LOCAL app.organization_id.
    // RLS must then match no rows rather than falling open.
    const leaked = await withoutTenantScope('maintenance:prune-expired', async (tx) => ({
      campaigns: await tx.select().from(campaigns),
      messages: await tx.select().from(messages),
      auditLogs: await tx.select().from(auditLogs),
    }));

    expect(leaked.campaigns).toEqual([]);
    expect(leaked.messages).toEqual([]);
    expect(leaked.auditLogs).toEqual([]);
  });

  it('rejects a write that targets another tenant', async () => {
    const error = await captureRejection(() =>
      withTenant({ organizationId: tenantA.organizationId }, (tx) =>
        tx.insert(campaigns).values({
          organizationId: tenantB.organizationId,
          name: 'cross-tenant write',
          locale: 'en',
        }),
      ),
    );

    // 42501 is insufficient_privilege, which is what an RLS WITH CHECK
    // violation raises. Asserting on the SQLSTATE rather than the wrapper
    // message means a mere syntax error cannot masquerade as a passing
    // security control.
    expect(databaseErrorMessage(error)).toMatch(/row-level security/i);
    expect(pgErrorCode(error)).toBe('42501');

    // Nothing was written.
    expect(await countAll('campaigns')).toBe(0);
  });

  it('cannot update another tenant’s row even by primary key', async () => {
    await seedCrossTenantFixtures();

    const sql = adminSql();
    const [victim] = await sql<{ id: string; name: string }[]>`
      SELECT id, name FROM campaigns WHERE organization_id = ${tenantB.organizationId}
    `;
    expect(victim).toBeDefined();

    const updated = await withTenant({ organizationId: tenantA.organizationId }, (tx) =>
      tx
        .update(campaigns)
        .set({ name: 'hijacked' })
        // Deliberately omits an organization_id predicate: this is exactly the
        // application bug RLS exists to contain.
        .where(eq(campaigns.id, victim!.id))
        .returning({ id: campaigns.id }),
    );

    expect(updated, 'update should have matched no rows').toEqual([]);

    const [after] = await sql<{ name: string }[]>`
      SELECT name FROM campaigns WHERE id = ${victim!.id}
    `;
    expect(after?.name).toBe(victim!.name);
  });

  it('cannot delete another tenant’s row', async () => {
    await seedCrossTenantFixtures();

    const sql = adminSql();
    const [victim] = await sql<{ id: string }[]>`
      SELECT id FROM assets WHERE organization_id = ${tenantB.organizationId}
    `;

    const deleted = await withTenant({ organizationId: tenantA.organizationId }, (tx) =>
      tx.delete(assets).where(eq(assets.id, victim!.id)).returning({ id: assets.id }),
    );

    expect(deleted).toEqual([]);
    expect(await countAll('assets')).toBe(2);
  });

  it('does not let one tenant read another’s organization record', async () => {
    const rows = await withTenant({ organizationId: tenantA.organizationId }, (tx) =>
      tx.select().from(organizations).where(eq(organizations.id, tenantB.organizationId)),
    );

    expect(rows).toEqual([]);
  });

  it('resets the tenant scope between transactions on a pooled connection', async () => {
    await seedCrossTenantFixtures();

    // SET LOCAL is transaction-scoped. Interleaving two tenants on the same pool
    // must not leak scope from one checkout to the next.
    const first = await withTenant({ organizationId: tenantA.organizationId }, (tx) =>
      tx.select().from(campaigns),
    );
    const second = await withTenant({ organizationId: tenantB.organizationId }, (tx) =>
      tx.select().from(campaigns),
    );
    const third = await withoutTenantScope('maintenance:prune-expired', (tx) =>
      tx.select().from(campaigns),
    );

    expect(first[0]?.organizationId).toBe(tenantA.organizationId);
    expect(second[0]?.organizationId).toBe(tenantB.organizationId);
    expect(third, 'scope must not persist past the transaction').toEqual([]);
  });

  it('refuses to build a tenant scope from a non-UUID value', async () => {
    // The one place a value is interpolated into SQL rather than bound, because
    // SET LOCAL takes no bind parameters. It must reject anything but a UUID.
    await expect(
      withTenant({ organizationId: "' OR '1'='1" }, async (tx) => tx.select().from(campaigns)),
    ).rejects.toThrow(/not a valid UUID/i);

    await expect(
      withTenant(
        { organizationId: `${tenantA.organizationId}'; DROP TABLE campaigns; --` },
        async (tx) => tx.select().from(campaigns),
      ),
    ).rejects.toThrow(/not a valid UUID/i);

    // The table is intact.
    expect(await countAll('campaigns')).toBe(0);
  });
});

describe('append-only tables', () => {
  it('rejects UPDATE and DELETE on audit_logs', async () => {
    await seedCrossTenantFixtures();

    const updateError = await captureRejection(() =>
      withTenant({ organizationId: tenantA.organizationId }, (tx) =>
        tx.update(auditLogs).set({ action: 'tampered' }),
      ),
    );
    expect(databaseErrorMessage(updateError)).toMatch(/append-only|permission denied/i);
    expect(pgErrorCode(updateError)).toBe('42501');

    const deleteError = await captureRejection(() =>
      withTenant({ organizationId: tenantA.organizationId }, (tx) => tx.delete(auditLogs)),
    );
    expect(databaseErrorMessage(deleteError)).toMatch(/append-only|permission denied/i);
    expect(pgErrorCode(deleteError)).toBe('42501');

    expect(await countAll('audit_logs')).toBe(2);
  });

  it('rejects UPDATE and DELETE on usage_records', async () => {
    const sql = adminSql();
    await sql`
      INSERT INTO usage_records (organization_id, metric, quantity)
      VALUES (${tenantA.organizationId}, 'AGENT_REQUEST', 1)
    `;

    const error = await captureRejection(() =>
      withTenant({ organizationId: tenantA.organizationId }, (tx) =>
        tx.execute(rawSql`UPDATE usage_records SET quantity = 999`),
      ),
    );
    expect(databaseErrorMessage(error)).toMatch(/append-only|permission denied/i);
    expect(pgErrorCode(error)).toBe('42501');

    expect(await countAll('usage_records')).toBe(1);
  });
});
