# Deployment

What to run, what to configure, what must be true before the first request, and
what will bite you if it is not.

---

## Topology

```
                  TLS termination / CDN
                           │
                  ┌────────┴────────┐
                  │  app instances  │  Next.js standalone, stateless, N ≥ 2
                  └────────┬────────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
   PostgreSQL 16      S3-compatible       n8n instance
   (as app_user)      object storage      (holds Drive + Meta credentials)
```

The application instances hold no state. Sessions, rate-limit windows and
idempotency records all live in Postgres, so an instance can be replaced at any
moment and a rolling deploy needs no draining beyond in-flight requests.

Agent calls can take minutes (`N8N_REQUEST_TIMEOUT_MS` defaults to five), so the
load balancer's idle timeout must exceed it. A proxy that cuts the connection at
60 seconds turns every image generation into a failure the user cannot
distinguish from a broken agent.

---

## The one thing that must not be got wrong

**Connect to PostgreSQL as `app_user`, never as a superuser.**

PostgreSQL exempts `SUPERUSER` and `BYPASSRLS` roles from row-level security
*entirely*. Not partially — the policies simply do not apply. A deployment that
connects as `postgres` has no tenant isolation at the database layer, and
nothing in the application will report a problem, because from the
application's point of view every query still works.

Verify it, on the real connection string, before serving traffic:

```sql
SELECT rolsuper OR rolbypassrls AS bypasses_rls
FROM pg_roles WHERE rolname = current_user;
-- must return: f
```

CI runs this same assertion. The tests would otherwise pass against a database
with no policies at all.

`drizzle/0001_rls.sql` creates `app_user` with exactly the privileges the
application needs — including no `UPDATE` or `DELETE` on `audit_logs`. Give it a
password out of band:

```sql
ALTER ROLE app_user LOGIN PASSWORD '<generated>';
GRANT CONNECT ON DATABASE <db> TO app_user;
```

---

## First deployment

### 1. Database

Apply the migrations in filename order, **as a superuser** (they create roles
and `SECURITY DEFINER` functions):

```bash
for m in drizzle/*.sql; do
  psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$m"
done
```

| | |
|---|---|
| `0000_init.sql` | Tables, enums, indexes, constraints |
| `0001_rls.sql` | Row-level security, append-only triggers, the `app_user` role |
| `0002_auth_path.sql` | `SECURITY DEFINER` functions for the authentication path |

`0001` and `0002` are idempotent. Then set `app_user`'s password as above, and
point `DATABASE_URL` at it.

### 2. Object storage

Create the bucket. It must be **private** — every read goes through a
short-lived presigned URL minted after the tenant check. A public bucket makes
`storage_key` the only thing standing between one tenant's assets and another's.

Enable SSE-AES256 (the writer requests it per object; a bucket default is
belt-and-braces) and set a lifecycle rule if you want soft-deleted assets purged
rather than retained.

### 3. Secrets

Generate each independently:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

| | |
|---|---|
| `AUTH_SECRET` | Session cookies and single-use tokens |
| `ENCRYPTION_KEY` | AES-256-GCM for `integrations.encrypted_credentials` |
| `N8N_CALLBACK_SECRETS` | Comma-separated; index 0 signs, all verify |

`src/server/config/env.ts` validates these at boot and **refuses to start** in
production if one is missing or too short. That is the intended behaviour: a
process that falls back to a default secret is worse than a process that does
not start, because it looks healthy.

### 4. Everything else

`.env.example` is the complete list, annotated. `APP_URL` must be the real
public origin — it builds the callback URLs handed to n8n and it is the value
the Origin check compares against, so a wrong one breaks every state-changing
request in a way that looks like a CSRF bug.

### 5. Verify before opening it up

```bash
curl -fsS https://<host>/api/v1/health
# {"status":"ok","checks":{"database":"ok","n8n":"configured","storage":"configured"},...}
```

Then register an organization, open the verification link from the mail (or from
the log, if `EMAIL_TRANSPORT=log`), sign in, and load the dashboard in both
`/ar` and `/en`.

---

## Building

```bash
docker build -t ai-workforce:$(git rev-parse --short HEAD) .
```

Three stages. The runtime layer carries no source, no dev dependencies and no
build toolchain, and runs as uid 1001.

**The build needs no runtime configuration.** `next build` imports every route
module to collect page data, so a module that validated `DATABASE_URL` at import
time would make a production build require production secrets. The database
client and the logger are lazily initialised behind a Proxy specifically to
prevent that. It means the build pipeline never has to be trusted with a
credential.

`output: 'standalone'` traces only the modules actually reached, which is what
keeps the runtime image small.

The `HEALTHCHECK` hits `/api/v1/health`, which returns **503** when Postgres is
unreachable — readiness, not just liveness, so an instance that cannot serve is
pulled from the pool rather than left in it answering errors.

---

## Local and evaluation

```bash
docker compose up
```

Postgres with the migrations applied on first boot, MinIO with the bucket
created, and the app connecting as `app_user` — the same least-privilege posture
as production.

`N8N_BASE_URL` is deliberately left unset. With no n8n instance the UI shows an
explicit "integration not configured" state rather than pretending an agent is
available (§52). Point it at a real instance to exercise the agents.

The compose credentials are fixed and public and there is no TLS. It is not a
production deployment.

For running the test suite against a local Postgres without Docker, see
`scripts/local-postgres.sh`.

---

## Configuration reference

Grouped by what breaks if it is wrong.

**Refuses to boot without it (production)** — `DATABASE_URL`, `APP_URL`,
`AUTH_SECRET`, `ENCRYPTION_KEY`.

**Feature is reported unconfigured without it** — `N8N_BASE_URL` and the three
webhook ids; `S3_*`. The product says so explicitly rather than degrading into
an empty state.

**Has a defensible default** — `DATABASE_POOL_MAX` (10),
`N8N_REQUEST_TIMEOUT_MS` (300 000), `S3_SIGNED_URL_TTL_SECONDS` (900),
`LOG_LEVEL` (info), `DEFAULT_LOCALE` (ar).

**Optional** — `N8N_CALLBACK_SECRETS` (required only once a workflow calls
back), `N8N_WEBHOOK_AUTH_HEADER`/`_VALUE`, `REDIS_URL`, `SMTP_URL`,
`SENTRY_DSN`, `OTEL_EXPORTER_OTLP_ENDPOINT`.

`REDIS_URL` is worth a note: when it is unset, rate limiting uses the
Postgres-backed limiter, which is correct and atomic, just slower. It does not
silently become a no-op. A limiter that quietly disables itself on a login
endpoint when a variable is missing is worse than no limiter, because everyone
believes it is there.

---

## Scaling

| Knob | |
|---|---|
| App instances | Stateless; scale horizontally. Each holds its own pool. |
| `DATABASE_POOL_MAX` | `instances × pool_max` must stay under Postgres `max_connections`. |
| PgBouncer | Supported — `prepare: false` is already set for transaction pooling mode. |
| Read replicas | Not wired up. Every query goes to the primary. Analytics is the natural first candidate. |
| Object storage | Serves media directly via presigned URLs; no application bandwidth is involved. |

The slowest paths are agent calls, and they are bounded by n8n, not by this
service. Adding app instances does not make an image generate faster.

---

## Deploying an update

1. Apply new migrations first. They are expand-only by convention — add a
   column, backfill, then drop in a later release — so the previous version
   keeps running against the new schema during a rolling deploy.
2. Roll instances. Sessions survive: they are database rows, not in-memory
   state.
3. Watch `/api/v1/health` and the error rate by `code` (see
   [observability.md](./observability.md)).

Rolling back the code is a redeploy. Rolling back a migration is not automatic —
see [disaster-recovery.md](./disaster-recovery.md).

---

## CI

`.github/workflows/ci.yml`, five jobs:

| Job | |
|---|---|
| `static` | Typecheck and lint |
| `test` | Vitest against a real Postgres **as `app_user`**, with the bypass assertion |
| `e2e` | Playwright, three projects, both writing directions |
| `audit` | `npm audit --omit=dev --audit-level=low` fails the build; dev-only advisories are reported without failing it |
| `migrations` | Applies every migration to an empty database, asserts `FORCE ROW LEVEL SECURITY` on every table carrying `organization_id`, and fails if `drizzle-kit generate` produces a new file — which would mean `schema.ts` had drifted from the checked-in SQL |

The audit split is deliberate. Production dependencies are held to zero known
vulnerabilities; blocking a release on a transitive dependency of a CLI tool
that cannot reach a deployed artifact trains people to ignore the check.

---

## Operational requirements not covered by code

| | |
|---|---|
| TLS | Terminate in front. HSTS with preload is already sent, so the certificate must be valid for every host that serves the app. |
| Backups | [disaster-recovery.md](./disaster-recovery.md). |
| Log retention | Structured JSON on stdout. Ship it somewhere with retention that matches your audit obligations. |
| Malware scanning | **Not implemented.** The hook point is `validateFile` in `src/server/storage/`, which already reads the bytes to check magic numbers — that is where a ClamAV or vendor call belongs, before the object is written. |
| Mail delivery | `EMAIL_TRANSPORT=smtp` requires `SMTP_URL`. With neither, `sendEmail` throws rather than pretending to have sent (§52). |
| Time | Webhook signatures accept ±5 minutes of skew. Run NTP. |
