-- ===========================================================================
-- Row-Level Security: the database-layer backstop for tenant isolation.
--
-- WHY THIS EXISTS
-- The tenant-scoped repository in src/server/tenancy is the primary control:
-- every query it issues carries an organization_id predicate. RLS is the
-- second, independent control that catches the case the repository cannot —
-- a query written by hand, a future contributor bypassing the repository, or
-- a `WHERE` clause dropped in a refactor. §9 of the spec requires isolation at
-- the database layer; frontend filtering alone is explicitly forbidden.
--
-- HOW IT WORKS
-- The application opens a transaction and issues
--     SET LOCAL app.organization_id = '<uuid>';
-- before touching any tenant table. Every policy below compares that setting
-- against the row's organization_id.
--
-- FAIL-CLOSED: `current_setting('app.organization_id', true)` returns NULL when
-- the setting was never applied. `organization_id = NULL` is NULL, never true,
-- so an unscoped query returns zero rows and an unscoped INSERT is rejected.
-- Forgetting to scope produces an empty result, never a cross-tenant leak.
--
-- FORCE ROW LEVEL SECURITY is applied so the table owner is also subject to the
-- policies. Note the standing Postgres caveat: roles with the BYPASSRLS
-- attribute and superusers are never subject to RLS. Production must therefore
-- connect as the non-superuser `app_user` role created at the bottom of this
-- file. See docs/multi-tenancy.md, "Deployment requirements".
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Helper: the organization the current transaction is scoped to.
-- STABLE (not IMMUTABLE) because the setting can change between statements.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_current_organization_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.organization_id', true), '')::uuid
$$;

COMMENT ON FUNCTION app_current_organization_id() IS
  'Organization scope for the current transaction, set via SET LOCAL app.organization_id. NULL when unscoped, which makes every tenant policy evaluate false.';

-- ---------------------------------------------------------------------------
-- Tenant tables: one USING policy (reads/updates/deletes) and one WITH CHECK
-- policy (inserts/updates) each, both anchored on organization_id.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'users',
    'sessions',
    'integrations',
    'conversations',
    'messages',
    'agent_requests',
    'agent_jobs',
    'knowledge_sources',
    'knowledge_syncs',
    'assets',
    'campaigns',
    'campaign_metrics',
    'usage_records',
    'audit_logs',
    'notifications'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
    EXECUTE format($p$
      CREATE POLICY %I ON %I
        USING (organization_id = app_current_organization_id())
        WITH CHECK (organization_id = app_current_organization_id())
    $p$, t || '_tenant_isolation', t);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- organizations: a tenant sees only its own row.
-- ---------------------------------------------------------------------------
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS organizations_tenant_isolation ON organizations;
CREATE POLICY organizations_tenant_isolation ON organizations
  USING (id = app_current_organization_id())
  WITH CHECK (id = app_current_organization_id());

-- ---------------------------------------------------------------------------
-- Partially-scoped tables.
--
-- system_events and webhook_deliveries carry a NULLABLE organization_id:
-- platform-wide events (n8n unreachable, a callback rejected before we could
-- identify a tenant) legitimately belong to no tenant. The policy therefore
-- admits rows whose organization_id matches OR is NULL. Those NULL rows contain
-- no tenant content by construction — enforced by the CHECK constraints below,
-- which keep free-text detail out of the un-scoped rows' reach.
-- ---------------------------------------------------------------------------
ALTER TABLE system_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS system_events_tenant_isolation ON system_events;
CREATE POLICY system_events_tenant_isolation ON system_events
  USING (organization_id IS NULL OR organization_id = app_current_organization_id())
  WITH CHECK (organization_id IS NULL OR organization_id = app_current_organization_id());

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS webhook_deliveries_tenant_isolation ON webhook_deliveries;
CREATE POLICY webhook_deliveries_tenant_isolation ON webhook_deliveries
  USING (organization_id IS NULL OR organization_id = app_current_organization_id())
  WITH CHECK (organization_id IS NULL OR organization_id = app_current_organization_id());

-- ---------------------------------------------------------------------------
-- Unauthenticated-path tables.
--
-- auth_tokens (email verification, password reset) and rate_limits are reached
-- before any tenant is known — that is the whole point of them. They hold no
-- tenant content: auth_tokens stores a user id and a SHA-256 hash, rate_limits
-- stores a counter. They are deliberately left without RLS, and the session
-- helper refuses to hand them out through the tenant repository.
-- ---------------------------------------------------------------------------
COMMENT ON TABLE auth_tokens IS
  'Intentionally not RLS-protected: reached before a tenant is known. Holds only a user id and a token hash.';
COMMENT ON TABLE rate_limits IS
  'Intentionally not RLS-protected: keyed by IP/email before authentication. Holds only counters.';

-- ---------------------------------------------------------------------------
-- Audit logs are append-only (§35).
--
-- Revoking UPDATE/DELETE covers the privilege path; the trigger covers the
-- owner path, so neither an application bug nor a compromised app credential
-- can rewrite history. Retention pruning is a DBA operation performed by a
-- role that first disables this trigger — see docs/security.md.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_logs_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (attempted %)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

DROP TRIGGER IF EXISTS audit_logs_append_only ON audit_logs;
CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_reject_mutation();

-- Same guarantee for the usage meter, which future billing will rely on.
DROP TRIGGER IF EXISTS usage_records_append_only ON usage_records;
CREATE TRIGGER usage_records_append_only
  BEFORE UPDATE OR DELETE ON usage_records
  FOR EACH ROW EXECUTE FUNCTION audit_logs_reject_mutation();

-- ---------------------------------------------------------------------------
-- The least-privilege application role.
--
-- Created NOLOGIN and without a password: deployment grants LOGIN and sets a
-- password out of band (see docs/deployment.md), so no credential is ever
-- committed here. It deliberately lacks BYPASSRLS and is not a superuser,
-- which is what makes the policies above load-bearing rather than decorative.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;

-- Append-only tables: no UPDATE/DELETE privilege at all.
REVOKE UPDATE, DELETE ON audit_logs FROM app_user;
REVOKE UPDATE, DELETE ON usage_records FROM app_user;

-- The app never issues DDL.
REVOKE CREATE ON SCHEMA public FROM app_user;

-- Tables added by later migrations inherit the same grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
