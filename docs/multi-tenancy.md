# Multi-tenancy

Each organization is a tenant. Isolation is enforced at the database, not in
application filters and certainly not in the frontend.

---

## Two independent controls

**1. PostgreSQL row-level security.** Every tenant table has RLS enabled *and*
`FORCE`d, so the table owner is bound by the policies too. Each policy compares
`organization_id` against `app_current_organization_id()`, which reads a
transaction-local setting:

```sql
CREATE POLICY campaigns_tenant_isolation ON campaigns
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
```

**2. A tenant-scoped repository.** `withTenant` is the only sanctioned way
application code reaches a tenant table. It opens a transaction, pins the scope,
and hands back a transaction handle:

```ts
const rows = await withTenant({ organizationId }, (tx) =>
  tx.select().from(campaigns).where(eq(campaigns.organizationId, organizationId)),
);
```

The explicit `where` is not redundant. It makes the intent visible in review and
gives the planner an index-friendly predicate — the composite indexes all lead
with `organization_id`. But if it were ever dropped, RLS would still be there.
Neither control depends on the other being correct.

---

## Fail-closed

`current_setting('app.organization_id', true)` returns NULL when the setting was
never applied. `organization_id = NULL` is NULL, never true, so:

- an unscoped SELECT returns **zero rows**;
- an unscoped INSERT is **rejected**.

Forgetting to scope a query produces an empty result or an error, never a
cross-tenant leak. This is the property worth protecting; it is why the policies
are written as an equality against a possibly-NULL setting rather than as an
`OR` with some bypass condition.

`SET LOCAL` is transaction-scoped and reset on COMMIT or ROLLBACK, so a pooled
connection cannot carry one tenant's scope into the next checkout. There is a
[test for exactly that](../tests/tenancy/isolation.test.ts).

---

## The deployment requirement that makes this real

> **Production must connect as `app_user`, not as a superuser.**

PostgreSQL exempts superusers and roles with `BYPASSRLS` from row-level security
entirely. Connecting as `postgres` does not weaken these policies — it removes
them.

`drizzle/0001_rls.sql` creates `app_user` with `NOBYPASSRLS`, no `LOGIN` and no
password; deployment grants those out of band so no credential is committed. The
role has `SELECT/INSERT/UPDATE/DELETE` on tenant tables, no `UPDATE`/`DELETE` on
the append-only ones, and no DDL.

The test suite and CI both connect as `app_user`, and CI asserts the role
carries neither attribute:

```sql
SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user  -- must be false
```

That check guards the guard. Without it, every isolation test in the suite would
pass against a database with no policies at all — which is not a hypothetical:
it is exactly what was happening during early development, and it hid a
production-blocking bug for hours. See below.

---

## The authentication path

Three operations legitimately run **before** any tenant is known:

1. **Resolving a session cookie** — the tenant is the *output* of this lookup,
   so it cannot be an input to it.
2. **Finding a user by email at login** — login takes an address, not a tenant.
3. **Creating the first organization** — there is no tenant yet, by definition.

Under a strict fail-closed policy all three return zero rows or are rejected, so
nobody can register and nobody can sign in.

### How this surfaced

It did not surface in development, because development connected as the
`postgres` superuser and bypassed RLS. It surfaced the moment the integration
tests began connecting as `app_user`: 25 of 28 auth tests failed immediately
with `new row violates row-level security policy for table "organizations"`.

Had the tests been written against a superuser connection — the easy default —
the product would have shipped completely unable to authenticate anyone.

### Case 3 needs no exception

Registration generates the organization's UUID in the application, pins
`app.organization_id` to it, and *then* inserts:

```ts
const organizationId = uuid();
await withTenant({ organizationId }, async (tx) => {
  await tx.insert(organizations).values({ id: organizationId, ... });
  // every dependent insert in this transaction is already correctly scoped
});
```

The policy's `WITH CHECK` passes normally. Doing it the other way round —
insert, then learn the id — is what fails, and correctly so.

One consequence: the old slug-uniqueness check (`SELECT … WHERE slug = ?` across
all organizations) returns nothing under RLS, which made every slug look free.
Uniqueness now rests on the unique index, with a retry on conflict.

### Cases 1 and 2 use SECURITY DEFINER functions

`drizzle/0002_auth_path.sql` defines a small set of functions that run as their
owner:

| Function | Purpose |
|---|---|
| `auth_resolve_session(token_hash)` | Session → identity. Matched on a unique index over a 256-bit value. |
| `auth_lookup_user_by_email(email)` | Login. Returns the password hash, lockout counters and ids. |
| `auth_lookup_user_by_id(uuid)` | Token redemption: resolves the tenant so the following write can be scoped. |
| `auth_email_exists(email)` | Registration duplicate check. Returns a **boolean**, never a row. |
| `auth_revoke_session` / `auth_revoke_user_sessions` / `auth_touch_session` | Session writes that cannot know their tenant. |
| `auth_prune_sessions(interval)` | Scheduled maintenance. Deletes by timestamp, returns a count. |

**Why this and not the alternatives:**

- Granting `BYPASSRLS` to the application role abandons the control everywhere
  in order to fix it in three places.
- Dropping RLS from `users` and `sessions` widens the blast radius of any
  forgotten `WHERE` clause, and `users` holds real tenant content.
- These functions confine the bypass to fixed signatures returning only the
  columns authentication needs — a reviewer can read all of them in a minute.

Every one pins `search_path = public, pg_temp`. Without that, a definer function
resolving an unqualified name through a caller-supplied `search_path` can be
tricked into executing an attacker's object with the owner's privileges.
`EXECUTE` is revoked from `PUBLIC` (Postgres grants it by default) and granted
only to `app_user`.

---

## Tables not under RLS, and why

| Table | Reason |
|---|---|
| `auth_tokens` | Reached before a tenant is known. Holds a user id and a SHA-256 hash — no tenant content. |
| `rate_limits` | Keyed by IP or email before authentication. Holds counters. |
| `system_events`, `webhook_deliveries` | RLS *is* enabled, with a policy admitting `organization_id IS NULL` rows, because a platform-wide event (n8n unreachable, a callback rejected before we could identify a tenant) genuinely belongs to no tenant. |

---

## Append-only tables

`audit_logs` and `usage_records` are append-only, enforced two ways:

- `app_user` has no `UPDATE`/`DELETE` privilege on them;
- a trigger raises `insufficient_privilege` on either, so **even the table
  owner** cannot rewrite history.

Verified in the test suite, including as a superuser.

---

## What the tests actually prove

[`tests/tenancy/isolation.test.ts`](../tests/tenancy/isolation.test.ts), run as
`app_user`:

| Assertion | |
|---|---|
| The test role has neither `SUPERUSER` nor `BYPASSRLS` | guards every other assertion |
| Every table listed as tenant-scoped has a `NOT NULL organization_id` | |
| Every one has RLS enabled **and** forced | |
| A tenant sees only its own rows across all seven content tables | by content, not just by count |
| An unscoped read returns zero rows | fail-closed |
| A cross-tenant INSERT is rejected | SQLSTATE `42501` |
| A cross-tenant UPDATE by primary key matches nothing | the forgotten-`WHERE` case |
| A cross-tenant DELETE matches nothing | |
| Scope does not survive a transaction on a pooled connection | |
| A non-UUID scope value is refused before it reaches SQL | `SET LOCAL` takes no bind parameters, so this is the one interpolation site |
| `audit_logs` and `usage_records` reject UPDATE and DELETE | |

Campaign-level isolation is covered separately: one tenant cannot launch
another's campaign, and is told `not_found` rather than `forbidden`, which
reveals nothing about another tenant's data.

---

## Adding a tenant-owned table

1. Add `organizationId` as a `NOT NULL` FK to `organizations` with
   `onDelete: 'cascade'`.
2. Lead its composite indexes with `organizationId`.
3. Add its name to the `tenant_tables` array in `drizzle/0001_rls.sql` and
   re-apply — the migration is idempotent.
4. Add it to `tenantScopedTables` in `src/server/db/schema.ts`. The isolation
   tests iterate that array, so a new table is checked automatically.
5. Reach it only through `withTenant`.

CI fails the build if any table carrying `organization_id` lacks
`FORCE ROW LEVEL SECURITY`, so step 3 cannot be silently skipped.
