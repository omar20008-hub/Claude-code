-- ===========================================================================
-- The authentication path vs. row-level security.
--
-- THE PROBLEM
-- RLS scopes every tenant table by `app.organization_id`, which the application
-- sets per transaction. But three operations legitimately run BEFORE any tenant
-- is known — that is what they are for:
--
--   1. Resolving a session cookie. The tenant is the *output* of this lookup,
--      so it cannot be an input to it.
--   2. Looking a user up by email at login. Same ordering problem: login takes
--      an address, not a tenant.
--   3. Creating the first organization. There is no tenant yet by definition.
--
-- Under a strict fail-closed policy all three return zero rows, so the product
-- simply cannot authenticate anyone. This surfaced as a test failure the moment
-- the suite began connecting as the least-privilege `app_user` role; it had
-- been invisible while development connected as a superuser, which bypasses RLS
-- entirely.
--
-- THE OPTIONS, AND WHY THIS ONE
--   (a) Grant the app role BYPASSRLS — abandons the control everywhere to fix
--       it in three places.
--   (b) Drop RLS from `users` and `sessions` — `users` holds real tenant
--       content (names, addresses, roles), so this widens the blast radius of
--       any forgotten WHERE clause.
--   (c) SECURITY DEFINER functions, below. The bypass is confined to two
--       narrow, reviewable functions with fixed signatures that return only
--       the columns authentication needs. Everything else stays fail-closed.
--
-- (c) keeps the policy strict and puts the exceptions somewhere a reviewer can
-- actually see them. Case 3 needs no exception at all: registration generates
-- the organization's UUID first and sets the scope to it before inserting, so
-- the WITH CHECK passes normally.
--
-- SECURITY DEFINER SAFETY
-- Every function below pins `search_path`, which is the standard hardening: a
-- definer function that resolves an unqualified name through a caller-supplied
-- search_path can be tricked into executing an attacker's object with the
-- owner's privileges.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Resolve a session from the SHA-256 of its cookie token.
--
-- Returns at most one row, matched on a unique index over a 256-bit value.
-- Guessing a token is the only way to reach any row, which is the same barrier
-- the session itself relies on.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_resolve_session(p_token_hash text)
RETURNS TABLE (
  session_id uuid,
  last_used_at timestamptz,
  user_id uuid,
  organization_id uuid,
  email text,
  name text,
  role text,
  user_locale text,
  user_status text,
  user_deleted_at timestamptz,
  organization_name text,
  organization_slug text,
  organization_locale text,
  timezone text,
  currency text,
  organization_deleted_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    s.id,
    s.last_used_at,
    u.id,
    u.organization_id,
    u.email,
    u.name,
    u.role::text,
    u.locale_preference::text,
    u.status::text,
    u.deleted_at,
    o.name,
    o.slug,
    o.default_locale::text,
    o.timezone,
    o.currency,
    o.deleted_at
  FROM sessions s
  JOIN users u ON u.id = s.user_id
  JOIN organizations o ON o.id = u.organization_id
  WHERE s.token_hash = p_token_hash
    AND s.revoked_at IS NULL
    AND s.expires_at > now()
  LIMIT 1
$$;

COMMENT ON FUNCTION auth_resolve_session(text) IS
  'Authentication path only. SECURITY DEFINER because the tenant scope is the result of this lookup, not an input to it. Matched on a unique 256-bit token hash.';

-- ---------------------------------------------------------------------------
-- Look a user up by email for login.
--
-- Returns only what the login flow needs: the password hash to verify, the
-- lockout counters, and the ids used to build the session. No tenant content
-- beyond the display name the session already exposes.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_lookup_user_by_email(p_email text)
RETURNS TABLE (
  id uuid,
  organization_id uuid,
  password_hash text,
  name text,
  status text,
  locale_preference text,
  failed_login_count integer,
  locked_until timestamptz,
  deleted_at timestamptz,
  organization_locale text,
  organization_deleted_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    u.id,
    u.organization_id,
    u.password_hash,
    u.name,
    u.status::text,
    u.locale_preference::text,
    u.failed_login_count,
    u.locked_until,
    u.deleted_at,
    o.default_locale::text,
    o.deleted_at
  FROM users u
  JOIN organizations o ON o.id = u.organization_id
  WHERE lower(u.email) = lower(p_email)
  LIMIT 1
$$;

COMMENT ON FUNCTION auth_lookup_user_by_email(text) IS
  'Authentication path only. SECURITY DEFINER because login takes an email address, not a tenant. Returns one row, exact-match on the unique lowercased email index.';

-- ---------------------------------------------------------------------------
-- Session writes that cannot know their tenant.
--
-- `auth_revoke_session` holds only a token; `auth_revoke_user_sessions` runs
-- after a password change, where the caller knows the user but the revocation
-- must reach sessions regardless of scope.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_revoke_session(p_token_hash text)
RETURNS integer
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH revoked AS (
    UPDATE sessions
       SET revoked_at = now()
     WHERE token_hash = p_token_hash
       AND revoked_at IS NULL
    RETURNING 1
  )
  SELECT count(*)::integer FROM revoked
$$;

CREATE OR REPLACE FUNCTION auth_revoke_user_sessions(p_user_id uuid)
RETURNS integer
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH revoked AS (
    UPDATE sessions
       SET revoked_at = now()
     WHERE user_id = p_user_id
       AND revoked_at IS NULL
    RETURNING 1
  )
  SELECT count(*)::integer FROM revoked
$$;

CREATE OR REPLACE FUNCTION auth_touch_session(p_session_id uuid)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE sessions SET last_used_at = now() WHERE id = p_session_id
$$;

-- ---------------------------------------------------------------------------
-- Maintenance: prune sessions that are expired, idle-timed-out or revoked.
--
-- A scheduled job has no tenant scope by nature. It deletes only by timestamp
-- and returns a count, so it cannot be used to read anything.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_prune_sessions(p_idle_timeout interval)
RETURNS integer
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH deleted AS (
    DELETE FROM sessions
     WHERE expires_at < now()
        OR last_used_at < now() - p_idle_timeout
        OR revoked_at IS NOT NULL
    RETURNING 1
  )
  SELECT count(*)::integer FROM deleted
$$;

-- ---------------------------------------------------------------------------
-- Grants.
--
-- EXECUTE is granted to the application role; the functions themselves run as
-- their owner. PUBLIC is revoked first because Postgres grants EXECUTE on new
-- functions to PUBLIC by default, which would hand these to every role.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION auth_resolve_session(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_lookup_user_by_email(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_revoke_session(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_revoke_user_sessions(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_touch_session(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_prune_sessions(interval) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION auth_resolve_session(text) TO app_user;
GRANT EXECUTE ON FUNCTION auth_lookup_user_by_email(text) TO app_user;
GRANT EXECUTE ON FUNCTION auth_revoke_session(text) TO app_user;
GRANT EXECUTE ON FUNCTION auth_revoke_user_sessions(uuid) TO app_user;
GRANT EXECUTE ON FUNCTION auth_touch_session(uuid) TO app_user;
GRANT EXECUTE ON FUNCTION auth_prune_sessions(interval) TO app_user;

-- ---------------------------------------------------------------------------
-- Look a user up by id, for the token-redemption flows.
--
-- Email verification and password reset start from a token, which yields a user
-- id but not a tenant. This resolves the scope so the subsequent UPDATE can run
-- normally under RLS.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_lookup_user_by_id(p_user_id uuid)
RETURNS TABLE (
  id uuid,
  organization_id uuid,
  email text,
  name text,
  status text,
  locale_preference text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT u.id, u.organization_id, u.email, u.name, u.status::text, u.locale_preference::text
  FROM users u
  WHERE u.id = p_user_id
  LIMIT 1
$$;

COMMENT ON FUNCTION auth_lookup_user_by_id(uuid) IS
  'Authentication path only. Resolves the tenant for a user reached through a single-use token, so the following write can be scoped normally.';

-- ---------------------------------------------------------------------------
-- Does an account already exist for this address?
--
-- Returns a boolean, never a row: registration needs to know whether the
-- address is taken and nothing else, so this cannot be used to read anything
-- about another tenant's users.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_email_exists(p_email text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM users WHERE lower(email) = lower(p_email))
$$;

COMMENT ON FUNCTION auth_email_exists(text) IS
  'Authentication path only. Returns a boolean rather than a row, so it leaks nothing beyond the fact registration already reveals.';

REVOKE ALL ON FUNCTION auth_lookup_user_by_id(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_email_exists(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup_user_by_id(uuid) TO app_user;
GRANT EXECUTE ON FUNCTION auth_email_exists(text) TO app_user;
