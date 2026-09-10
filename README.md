# AI Workforce

A multi-tenant SaaS that gives an organization three AI employees — a
**Knowledge** agent, a **Creative** agent and an **Advertising** agent — through
one interface that works equally well in Arabic (RTL) and English (LTR).

The agents themselves are existing n8n workflows. This platform is everything
around them: identity, tenancy, the agent gateway, conversations, jobs, assets,
campaigns, analytics, audit and the product surface. It does not rebuild the RAG
engine, the image generator or the Meta integration — and it does not pretend
they can do things they cannot.

---

## Start here

**[docs/agent-contracts.md](./docs/agent-contracts.md)** is the most important
document in the repository. It records what the three workflows actually do,
read from their live definitions rather than assumed. Five findings contradict
what a reader would reasonably expect, and the product is built to the reality:

1. All three are n8n **chat triggers**, not JSON webhooks. No request schema, no
   structured response, no execution id.
2. The callback architecture in the brief **does not exist** in these workflows.
   The endpoint is built and tested anyway; it receives no traffic today.
3. The Creative workflow **cannot generate video** — the model quota is zero and
   its own prompt forbids it. A video request produces a key-frame image, and
   the UI says so.
4. The Advertising workflow **never launches anything**. Every Meta object is
   created `PAUSED` and there is no activation step, so a successful launch
   reports `PAUSED`, never `ACTIVE`.
5. **Meta performance metrics are unobtainable** — there is no Insights node.
   The API reports `available: false` rather than zeros.

Reporting zeros for (5) would tell a user nobody saw their ad. Reporting
`ACTIVE` for (4) would tell them money is being spent. Neither is true.

---

## Quick start

```bash
docker compose up
```

Postgres with the migrations applied, MinIO with the bucket created, and the app
connecting as the least-privilege `app_user` role — the same posture production
requires. Open http://localhost:3000 and register an organization; the
verification link is written to the log.

`N8N_BASE_URL` is deliberately unset, so the agent surfaces show an explicit
"integration not configured" state rather than pretending an agent is available.
Point it at a real instance to exercise them.

### Development

```bash
npm install
cp .env.example .env          # then fill in DATABASE_URL and the secrets
./scripts/local-postgres.sh   # Postgres + migrations + the app_user role
npm run dev
```

### Scripts

| | |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run verify` | typecheck + lint + tests |
| `npm test` | Vitest, against a real Postgres |
| `npm run test:e2e` | Playwright, three projects, both writing directions |
| `npm run db:generate` / `db:migrate` | Drizzle |
| `npm run openapi` | regenerates `docs/openapi.json` from the route schemas |

---

## Architecture in one screen

```
Browser ──► middleware (locale negotiation) ──► app/[locale]/
                                                    │
     Server Component ──► service ──► withTenant(tx) ──► Postgres + RLS
                                          │
     Client Component ──► /api/v1/* ──► route()
                             correlation id · Origin check ·
                             Zod validation · rate limit
                                          │
                                    invokeAgent()
                                          │
                              AgentAdapter ──► n8n chat webhook
```

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 15 App Router, React 19 | Tenant-scoped queries run on the server; only rendered output reaches the browser |
| Database | PostgreSQL 16 | Row-level security. No other mainstream database enforces tenant isolation at the storage layer this cleanly |
| ORM | Drizzle | SQL-shaped, reviewable migrations |
| Styling | Tailwind v4 | Its `ms-*`/`ps-*`/`start-*` utilities compile to CSS logical properties |
| i18n | next-intl | Locale-prefixed routes, ICU MessageFormat — Arabic needs six plural categories |
| Auth | in-house | Opaque tokens with authoritative server-side revocation |

`src/server/**` is server-only and never imported by a Client Component.
Nothing outside `src/server/agents/` knows n8n exists.

---

## Three properties worth knowing

**Tenant isolation is enforced by the database.** Every tenant table carries
`organization_id NOT NULL` with `FORCE ROW LEVEL SECURITY` and a fail-closed
policy; `withTenant` sets `app.organization_id` per transaction. The application
must connect as `app_user` — a superuser connection removes the policies
entirely rather than weakening them, which is why CI asserts the test role has
neither `SUPERUSER` nor `BYPASSRLS`. Running the suite that way is what exposed
a production-blocking RLS bug on the authentication path that development, as
`postgres`, could not see.

**Both directions are checked by machines.** No component may contain a
physical-side utility (`ml-*`, `text-left`, `left-0`). A source scan, an
assertion against the *built* CSS, and Playwright geometry checks all enforce
it — because a physical property looks perfect in English and is wrong only for
Arabic readers, which is exactly the class of bug that survives review. The
shipped bundle currently contains **zero** physical-direction properties.

**Nothing is faked.** No stubbed n8n response, no simulated campaign launch, no
placeholder metrics. When an integration is unavailable the product says so, in
the reader's language, with the reason.

---

## Documentation

| | |
|---|---|
| [agent-contracts.md](./docs/agent-contracts.md) | What the workflows really do. **Read first.** |
| [architecture.md](./docs/architecture.md) | Structure, technology decisions, request flow |
| [multi-tenancy.md](./docs/multi-tenancy.md) | RLS, `withTenant`, the isolation proof |
| [authentication.md](./docs/authentication.md) | Registration through recovery; the role model |
| [security.md](./docs/security.md) | Every control, and the known gaps |
| [database.md](./docs/database.md) | Schema, migrations, query patterns |
| [n8n-integration.md](./docs/n8n-integration.md) | Transport, gateway, jobs, the callback endpoint |
| [api.md](./docs/api.md) · [openapi.json](./docs/openapi.json) | Endpoints and the error contract |
| [localization.md](./docs/localization.md) | Catalogues, plurals, numerals, dates |
| [rtl-ltr.md](./docs/rtl-ltr.md) | How one component tree serves both directions |
| [observability.md](./docs/observability.md) | Logs, audit trail, system events, health |
| [deployment.md](./docs/deployment.md) | Topology, configuration, CI |
| [disaster-recovery.md](./docs/disaster-recovery.md) | Backup requirements and restore procedure |

---

## Verification

| Area | |
|---|---|
| Tenant isolation | 13 tests, as a non-superuser role |
| Password hashing and policy | 13 |
| Registration, verification, login, reset | 28 |
| Webhook signatures | 18, each written from the attacker's side |
| Campaign approval, launch, idempotency | 22, under genuine database concurrency |
| Agent transport and citation parsing | 38 |
| Localization | 30 |
| End-to-end, both languages and directions | 74 |

Production dependencies: **0 known vulnerabilities**.
