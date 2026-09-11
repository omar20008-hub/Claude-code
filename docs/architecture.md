# Architecture

## What this is

A multi-tenant SaaS that gives an organization three AI employees — a Knowledge
agent, a Creative agent and an Advertising agent — through one bilingual
(Arabic/English) interface. The agents themselves already exist as n8n
workflows. This platform is everything around them: identity, tenancy, the
agent gateway, conversations, jobs, assets, campaigns, analytics, audit and the
product surface.

It does not rebuild the RAG engine, the image generator or the Meta integration.
It also does not pretend they can do things they cannot — see
[agent-contracts.md](./agent-contracts.md), which is the most important document
in this directory.

---

## Technology decisions

| Layer | Choice | Why this one |
|---|---|---|
| Framework | Next.js 15 (App Router), React 19 | Server Components let tenant-scoped queries run on the server and ship only rendered output, so no tenant data reaches a browser that should not have it. One deployable unit for UI and API. |
| Language | TypeScript, `strict` + `noUncheckedIndexedAccess` | The agent contracts, the money units and the tenant ids are exactly the things a type system should be protecting. |
| Database | PostgreSQL 16 | Row-level security is the reason. No other mainstream database enforces tenant isolation at the storage layer this cleanly. |
| ORM | Drizzle | SQL-shaped, no hidden query generation, and the schema is TypeScript that produces reviewable migration SQL. |
| Styling | Tailwind v4 | Its `ms-*`/`me-*`/`ps-*`/`pe-*` utilities compile to CSS logical properties, which is what makes one stylesheet correct in both writing directions. |
| i18n | next-intl | Locale-prefixed routing, ICU MessageFormat (Arabic needs six plural categories), and per-request catalogue loading so a page ships one language. |
| Auth | Built in-house | Opaque session tokens with server-side revocation. See [authentication.md](./authentication.md) for why not a JWT and why not a framework. |
| Storage | S3-compatible | Media never belongs in Postgres. MinIO locally, any S3 API in production. |
| Tests | Vitest + Playwright | Integration tests against a real Postgres as the least-privilege role; E2E in both languages and both directions. |

### Why not a separate backend service

A separate API service would add a network hop, a second deployment, a second
auth surface and a shared-types problem, in exchange for independent scaling
this workload does not need. The boundary that actually matters —
`src/server/**` is server-only, everything else may be client — is enforced by
module structure and by React's `'use client'` directive, not by a process
boundary.

If that changes, `src/server/services/` is already the seam: the route handlers
are thin, and the services take plain arguments and return plain data.

---

## Request flow

```
Browser
  │  locale-prefixed URL, session cookie
  ▼
middleware.ts ─────────── negotiates locale, redirects to /ar or /en
  │                       (deliberately does NOT check auth: that needs a
  │                        database read, which does not belong on every
  │                        request for a static asset)
  ▼
app/[locale]/(app)/layout.tsx ── requireSession(): the auth boundary
  │
  ├── Server Component ──► service ──► withTenant(tx) ──► Postgres + RLS
  │                                                        │
  └── Client Component ──► /api/v1/* ──► route() ──────────┘
                             │  correlation id, Origin check,
                             │  Zod validation, rate limit
                             ▼
                          service ──► Agent Gateway ──► adapter ──► n8n
```

### The Agent Gateway

```
service (knowledge / asset / campaign)
   │  action, payload, locale, idempotency key
   ▼
invokeAgent()  ── writes agent_requests BEFORE the call, so a process that
   │              dies mid-flight still leaves evidence a request was made
   │           ── creates agent_jobs for long-running work
   │           ── checks per-tenant idempotency and short-circuits a replay
   │           ── meters usage
   ▼
AgentAdapter (Knowledge | Creative | Advertising)
   │  the only code that knows n8n exists
   ▼
n8n chat webhook
```

Adapters also declare what they cannot do. `capabilities()` returns an
`unavailable[]` list of `{ capability, reasonKey }`, and the UI renders those
reason keys directly. That is why the product's claims cannot drift from the
workflows' behaviour: when video generation is off in n8n, the Creative Studio
says so because the adapter says so.

---

## Directory layout

```
src/
├── middleware.ts              locale negotiation
├── i18n/                      routing, config, formatting, bidi helpers
├── lib/                       framework-free: errors, ids, password policy
├── components/
│   ├── ui/primitives.tsx      server-renderable design system
│   ├── ui/form.tsx            'use client' form controls (context-wired)
│   └── <feature>/             feature components
├── app/
│   ├── [locale]/(auth)/       public pages
│   ├── [locale]/(app)/        authenticated pages
│   └── api/v1/                versioned API
└── server/                    NEVER imported by a Client Component
    ├── config/env.ts          validated environment
    ├── db/                    schema and lazy client
    ├── tenancy/context.ts     withTenant — the only sanctioned data path
    ├── auth/                  password hashing, sessions
    ├── agents/                gateway, contracts, adapters, citation parsing
    ├── services/              domain logic
    ├── security/              rate limiting, webhook signatures
    ├── storage/               object store and file validation
    └── observability/         structured logging
```

---

## The load-bearing decisions

### Tenant isolation is enforced twice, independently

Every tenant query runs inside `withTenant`, which pins `app.organization_id`
for the transaction; RLS policies compare it against every row. The repository
*also* carries an explicit `organizationId` predicate. Neither control depends
on the other being correct. Full detail in [multi-tenancy.md](./multi-tenancy.md).

The subtlety worth knowing up front: three operations legitimately precede a
known tenant — resolving a session, finding a user by email, creating the first
organization. They are handled by narrowly-scoped `SECURITY DEFINER` functions
in `drizzle/0002_auth_path.sql`, not by granting the application role
`BYPASSRLS`.

### Localization is a data structure, not a translation pass

No user-facing string is authored in a component. The API returns error *codes*,
not messages; notifications store an i18n key plus parameters; audit rows store
`campaign.launched`, never "Launched a campaign". The consequence is that one
backend serves an Arabic and an English user correctly, and an event recorded by
an Arabic-speaking colleague renders in English for whoever reads it next.

### Direction is structural, not cosmetic

No component contains a physical-side utility. Every inline axis is logical, so
the browser resolves it against `dir`. A test scans every source file and the
built stylesheet; the shipped CSS contains zero physical-direction properties.
See [rtl-ltr.md](./rtl-ltr.md).

### Honesty about capability is a product feature

Where an integration genuinely cannot supply something, the platform says so and
names the reason, rather than rendering a zero. Zeros lie: "0 impressions" reads
as "nobody saw this ad", not "we cannot see this number". This is why
`MetricValue<T>` is a discriminated union with an `available: false` branch, why
`getCampaignPerformance` returns it, and why the dashboard has an
"unavailable metrics" notice at all.

---

## Where the risk is concentrated

| Path | Risk | Control |
|---|---|---|
| Campaign launch | Real money on a real ad account | Explicit approval with an immutable snapshot; conditional status claim; two unique indexes; required `Idempotency-Key`. [Tested](../tests/campaigns/lifecycle.test.ts) including under genuine database concurrency. |
| Tenant queries | Cross-tenant disclosure | RLS + scoped repository, verified as a non-superuser role. |
| Session resolution | Account takeover | Opaque tokens, stored hashed, `__Host-` cookie, immediate revocation. |
| Inbound callbacks | Forged state changes | HMAC + timestamp + database-backed nonce replay protection. |
| Generated media | Stored XSS, path traversal | Magic-number validation, generated keys, `Content-Disposition: attachment`, presigned URLs minted only after a tenant check. |

---

## Further reading

- [agent-contracts.md](./agent-contracts.md) — what the workflows really do
- [n8n-integration.md](./n8n-integration.md) — the gateway and the callback path
- [multi-tenancy.md](./multi-tenancy.md) — isolation, and the auth-path exception
- [authentication.md](./authentication.md) — sessions, passwords, lockout
- [database.md](./database.md) — schema and constraints
- [api.md](./api.md) — endpoints and error contract
- [localization.md](./localization.md) — the i18n architecture
- [rtl-ltr.md](./rtl-ltr.md) — direction handling
- [security.md](./security.md) — controls and threat coverage
- [observability.md](./observability.md) — logs, correlation, monitoring
- [deployment.md](./deployment.md) — how to run it
- [disaster-recovery.md](./disaster-recovery.md) — backups, RPO/RTO
