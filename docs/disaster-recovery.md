# Disaster recovery

What is stateful, what backing it up requires, and what recovery actually looks
like for each failure mode.

This document describes a **procedure, not an installed system**. No backup
schedule is configured by this repository — that belongs to whoever operates the
database. What follows is what the schema and the architecture require of it.

---

## What holds state

| | Recoverable from | Loss is |
|---|---|---|
| **PostgreSQL** | backups only | catastrophic — tenants, users, sessions, conversations, campaigns, the audit trail |
| **Object storage** | backups only | permanent loss of generated assets; rows survive and point at missing objects |
| **App instances** | rebuild from the image | nothing; they are stateless |
| **n8n** | n8n's own backups | the agents, the Drive index and the Meta credential — **not this repository's concern, but a hard dependency** |

Two things follow from that table.

**The application layer needs no backup.** Sessions, rate-limit windows and
idempotency records are all database rows, so an instance can be destroyed and
replaced at any moment.

**n8n is a dependency with its own recovery story.** The Google Drive OAuth
credential and the Meta Graph token live in n8n's credential store, not here. If
n8n is lost, this platform is intact but has no agents — every agent surface
reports `integration_not_configured`, honestly, and nothing else breaks. Recovery
means restoring n8n, and its credential encryption key is part of that.

The Knowledge vector store is **in-memory** in n8n under key
`gdrive_agentic_kb`, so it is lost on any n8n restart until the next scheduled
rebuild (every 6 hours). That is a property of the workflow, not a failure, but
it is worth knowing before anyone panics about a restart.

---

## PostgreSQL

### What to run

Both, not either:

- **Continuous archiving** (WAL shipping / PITR) for point-in-time recovery.
  This is the one that matters: the realistic disaster is a bad migration or an
  erroneous bulk delete at a known moment, and PITR is the only thing that
  recovers the state just before it.
- **Periodic base backups**, retained per your obligations and stored in a
  different failure domain than the primary.

Managed Postgres (RDS, Cloud SQL, Neon, Supabase) provides both. Enable them and
verify the retention window is the one you think it is.

### Encryption and access

The dump contains every tenant's data, and row-level security **does not apply
to it** — a backup is a file, not a query. Encrypt at rest, restrict who can
read it, and treat access to backup storage as equivalent to superuser access to
production.

### Restore

```bash
# 1. Restore to a NEW database, never over the live one.
pg_restore -d ai_workforce_restored --no-owner --no-privileges backup.dump

# 2. Recreate the role grants (a dump does not carry the role's password).
psql -d ai_workforce_restored -c \
  "ALTER ROLE app_user LOGIN PASSWORD '<generated>';
   GRANT CONNECT ON DATABASE ai_workforce_restored TO app_user;"

# 3. Verify RLS survived the restore — this is the step people skip.
psql -d ai_workforce_restored -tAc "
  SELECT count(*) FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN information_schema.columns col
    ON col.table_name = c.relname AND col.table_schema = 'public'
  WHERE n.nspname='public' AND c.relkind='r'
    AND col.column_name='organization_id'
    AND NOT (c.relrowsecurity AND c.relforcerowsecurity)"
# must return: 0

# 4. Verify the application role still cannot bypass it.
psql "$RESTORED_APP_URL" -tAc \
  "SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user"
# must return: f
```

Steps 3 and 4 are not ceremony. `pg_restore --no-owner` and various
dump/restore paths can leave policies present but not `FORCE`d, or leave the
application connecting as the restoring superuser. Either outcome is a database
that works perfectly and has no tenant isolation, and **nothing in the
application will notice**. The same two assertions run in CI on every build, for
the same reason.

Then repoint `DATABASE_URL` and restart.

### Test the restore

A backup that has never been restored is a hypothesis. Restore into a scratch
database quarterly, run the two assertions above, and sign in as a test tenant.

---

## Object storage

Enable **versioning** and cross-region replication on the bucket. Versioning is
the cheap defence against the likely accident — an overwrite or an erroneous
lifecycle rule — and it costs nothing to have turned on before you need it.

Restoring the database to an earlier point does **not** roll back object
storage. After a PITR, `assets` rows may reference objects deleted since that
moment. The application handles this correctly rather than crashing: a presigned
URL for a missing object yields a storage error with a reference id, not a blank
page. But the asset is gone, and the user should be told rather than left with a
broken download.

Reconciling the two is a query, not a feature: list `storage_key` for
non-deleted assets, diff against the bucket, and soft-delete the orphans.

---

## Failure modes

### Bad migration

Migrations are expand-only by convention — add a column, backfill, drop in a
later release — so the previous application version keeps running against the
new schema and **rolling back the code is a redeploy**.

A migration that genuinely destroys data has no automatic rollback. PITR to just
before it, then replay any writes that matter. This is the case PITR exists for;
plan the maintenance window on the assumption you might need it.

### One tenant's data corrupted or deleted

Restore a copy to a scratch database, extract that tenant's rows by
`organization_id`, and reinsert into production inside `withTenant`.

Every tenant table carries `organization_id NOT NULL`, so "that tenant's rows"
is a precise, complete set — which is exactly the property that makes
single-tenant recovery possible at all. `audit_logs` is append-only and cannot
be rewritten even by the table owner, so the trail of what happened survives the
incident that prompted the restore.

### Total region loss

1. Restore Postgres in the new region.
2. Point object storage at the replica (or restore it).
3. Deploy the image; the instances are stateless.
4. Verify `/api/v1/health` returns `ok`.
5. Repoint DNS.

Sessions survive — they are rows. Users stay signed in.

n8n has to be recovered separately. Until it is, the agent surfaces report
`integration_not_configured` rather than failing obscurely, and everything else
in the product works.

### Secret compromise

| Secret | Response |
|---|---|
| `AUTH_SECRET` | Rotate and revoke every session (`DELETE FROM sessions`). Everyone signs in again. Outstanding verification and reset tokens are invalidated; users request new ones. |
| `N8N_CALLBACK_SECRETS` | Prepend a new value, deploy, update the workflows, then drop the old one. Zero downtime: index 0 signs, all values verify. |
| `ENCRYPTION_KEY` | Re-encrypt `integrations.encrypted_credentials` — null today, so this is currently a no-op. Doing it before that changes is far cheaper. |
| Database credentials | `ALTER ROLE app_user PASSWORD`, redeploy. |
| Third-party (Drive, Meta) | **Rotate in n8n.** This application never held them. |

---

## Targets

No RPO or RTO is contractually committed here, because they are a function of
the backup configuration the operator chooses, not of this code. What the
architecture supports:

| | |
|---|---|
| RPO | Bounded by the WAL archive interval — seconds to minutes with continuous archiving. |
| RTO | Bounded by database restore time. The application layer contributes only an image pull and a start. |

The application does not extend either. That is the intended outcome of keeping
every piece of state in Postgres and object storage, and none of it in a
process.
