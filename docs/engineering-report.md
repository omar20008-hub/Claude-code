# Final engineering report

AI Workforce — bilingual, multi-tenant SaaS over three existing n8n agents.

---

## 1. Executive summary

A production-ready platform that wraps three existing n8n AI agents in a
multi-tenant, bilingual (Arabic RTL / English LTR) SaaS. It supplies the entire
product layer — identity, tenancy, the agent gateway, conversations, jobs,
assets, campaigns, analytics, audit, integrations, security and deployment —
and rebuilds none of the AI.

The single decision that shaped everything: **the workflows were read before the
code was written**, and where they contradicted the brief, the product was built
to the workflows. Five contradictions were found, and each is surfaced to users
as a stated limitation rather than papered over. Notably, a "launched" campaign
reports `PAUSED` because Meta objects are created paused with no activation
step, and Meta performance metrics are reported unavailable because the workflow
has no Insights node.

Delivered: 20 tables under enforced row-level security, 26 API paths / 33
operations, 15 pages in two languages and two writing directions, 162 unit and
integration tests against a real PostgreSQL as a least-privilege role, 74
end-to-end tests across three browser projects, a five-job CI pipeline, a
hardened container image, and 14 documents.

Not delivered, deliberately: billing, roles beyond ADMIN, MFA, SSO, malware
scanning, SMTP delivery. Each is recorded in §15 with the reason.

---

## 2. Scope and method

The brief specified 56 areas. The work began with §51 and §54 — inspect the
existing repository and the live workflows first, do not invent schemas, do not
generate hundreds of files immediately.

That order mattered. The brief described a REST integration with callbacks; the
workflows are chat triggers with no callback nodes. Building the described
architecture first and discovering that second would have wasted the majority of
the integration layer.

`docs/agent-contracts.md` is the artefact of that phase and remains the most
important document in the repository.

---

## 3. What the workflows actually do

| Finding | Consequence in the product |
|---|---|
| All three are n8n **chat triggers**, not JSON webhooks — no request schema, no structured response, no execution id | A transport layer normalising three wire formats; correlation ids owned by the SaaS |
| **No workflow calls back.** §24's callback architecture does not exist | The endpoint is built, signed and tested; it receives no traffic and the docs say so |
| The Creative workflow **cannot generate video** — Veo quota is zero and the agent's prompt forbids it | Video is disabled *with the reason shown*, results carry `downgradedFrom: 'VIDEO'` |
| The Advertising workflow **never activates anything** — every Meta object is created `PAUSED` | A successful launch reports `PAUSED`, never `ACTIVE`, in both languages |
| **Meta metrics are unobtainable** — no Insights node exists | Analytics returns `available: false` with a reason key, never zeros |

The last two are the ones that would have caused real harm if faked. "ACTIVE"
tells a user money is being spent. "0 impressions" tells them nobody saw their
ad. Both would be statements about the world, made from an absence of data.

---

## 4. Architecture

Next.js 15 App Router with React 19, one deployable unit for UI and API.
Server Components run tenant-scoped queries on the server and ship rendered
output, so tenant data does not reach a browser that should not have it.

Layering: pages → services → `withTenant` → PostgreSQL. Route handlers are thin;
`src/server/services/` holds domain logic and takes plain arguments, which is
the seam if a separate API service is ever needed.

`src/server/**` is server-only and is never imported by a Client Component.
Nothing outside `src/server/agents/` knows n8n exists — the rest of the
application speaks `AgentRequest` / `AgentResponse`.

A separate backend service was rejected: it would add a network hop, a second
deployment, a second auth surface and a shared-types problem in exchange for
independent scaling this workload does not need.

---

## 5. Data model

20 tables. Every tenant table carries `organization_id NOT NULL` with a cascading
foreign key; composite indexes lead with it, so the scoped query is also the
fast query.

Conventions worth naming: money in **minor units as bigint** (Meta's Graph API
uses minor units too, so there is no rounding step at the boundary); timestamps
`timestamptz`; soft deletion on user-visible content only — `audit_logs` and
`usage_records` are append-only.

`campaigns` carries the most constraints because it is the table that can cost
money: unique `meta_campaign_id`, a partial unique index on
`(organization_id, launch_idempotency_key)`, and CHECK constraints on age range,
budget and schedule order. `approved_snapshot` freezes exactly what the approver
saw, and any edit clears the approval.

Three migrations: schema, RLS, and the authentication-path functions. CI applies
all three to an empty database and fails if `drizzle-kit generate` produces a new
file, which would mean the schema had drifted from the checked-in SQL.

---

## 6. Multi-tenancy

Two independent controls, fail-closed.

`FORCE ROW LEVEL SECURITY` on every tenant table, with policies reading
`current_setting('app.organization_id')`. Unscoped, they deny — an omitted
`SET LOCAL` yields zero rows, not every row. `withTenant` sets it per
transaction and is the only sanctioned data path.

The one SQL interpolation site in the codebase is `SET LOCAL
app.organization_id`, which takes no bind parameters. It is guarded by a strict
UUID pattern, with tests feeding it `' OR '1'='1` and a `DROP TABLE` payload.

**The deployment requirement is part of the control**: PostgreSQL exempts
superusers and `BYPASSRLS` roles from RLS entirely, so production must connect
as `app_user`. CI asserts the test role carries neither attribute — otherwise
every isolation test would pass against a database with no policies at all.

Cross-tenant reads return `not_found`, never `forbidden`, so the API does not
confirm that another tenant's resource exists.

---

## 7. Authentication

Opaque session tokens rather than JWTs, because revocation had to be
authoritative: sessions are revoked on logout, password change and password
reset. A stateless token needs a denylist that reintroduces the same lookup plus
a second source of truth.

scrypt at OWASP parameters with the cost encoded in the hash, so old hashes
upgrade in place on next login. Sessions stored only as SHA-256. `__Host-`
cookie prefix — browser-enforced, and the only defence against a compromised
subdomain overwriting the cookie. Registration issues no session; the account is
`PENDING_VERIFICATION` until the emailed link is opened.

Password screening is structural rather than a block list. `password1234` was
accepted by the first implementation and found in live testing. The fix runs two
independent normalisations — strip padding, translate leetspeak — because doing
them in sequence turns `password1234` into `passwordiea`, which matches nothing.

Roles: the enum, the column and `session.role` exist; **no permission checks are
implemented**, per §10. Adding them means writing a permission map and calling it
in `route()` — not a schema change, not a page change.

---

## 8. The agent gateway

`invokeAgent()` writes `agent_requests` **before** the call, so a process that
dies mid-flight still leaves evidence. That row is the audit spine for all AI
activity and the source of every dashboard "requests" figure — written before
rather than after, so the figures count activity, not successes.

Three response formats normalise through one parser. The join rule is
format-sensitive: token frames concatenate with no separator, whole messages
join with a blank line. Getting it backwards either runs paragraphs together or
shreds sentences.

Idempotency is per tenant, on a partial unique index, so two organizations may
reuse a key. There is **no automatic retry** — these calls spend money and
produce stored artefacts, and a generic retry wrapper in front of a workflow
that creates Meta objects is a duplicate-spend generator.

Adapters declare their own limits through `capabilities()`, returning
`unavailable[]` entries the UI renders directly. That is what makes the
product's claims structurally unable to drift from the workflows' behaviour.

---

## 9. Localization

Locale-prefixed routing with server-side negotiation, ICU MessageFormat, and
per-request catalogue loading so a page ships one language.

Arabic has **six plural categories**; a `count === 1 ? … : …` ternary is wrong in
Arabic in four of them. Numerals, dates and currency are formatted through
`Intl` with the tenant's timezone and currency.

Two catalogue defects were found by tests written after the fact, and both were
invisible to the tests that existed:

- 26 keys were unreachable because next-intl resolves keys by splitting on dots,
  and the action keys contained dots. Both existing i18n tests flattened
  catalogues *with* dots, so neither could see it. A third test now walks the raw
  objects.
- `t('backToLogin')` was called in the wrong namespace. A usage-analysis test now
  checks every call site against the catalogue, and was proved non-vacuous by
  injecting a bad key.

---

## 10. RTL / LTR

One component tree, no mirrored stylesheet, and no `dir === 'rtl' ? … : …`
conditional. **No component contains a physical-side utility** — everything is
CSS logical properties, resolved by the browser against `dir`, which is set on
the server so there is no flash of mis-directed layout.

Enforced by machine, because a physical property looks perfect in English and is
wrong only for Arabic readers — exactly the class of bug that survives review.
Three checks: a source scan, an assertion against the **built** CSS, and
Playwright geometry.

The built-CSS check is not hypothetical belt-and-braces. The shipped bundle once
contained a physical padding and a physical text alignment because Tailwind's
scanner had read those class names out of a **code comment explaining they were
forbidden**. Current state: zero physical-direction properties in the shipped
CSS.

Content direction is separate from UI direction: each chat message carries its
own `dir`, and Latin runs inside Arabic prose are bidi-isolated so filenames and
IDs do not visually reorder.

---

## 11. Security

Fifteen control families, each documented with its rationale in
`docs/security.md`. The ones that shaped code most:

CSRF as `SameSite=Lax` **plus** an Origin check that refuses a request with no
Origin and no acceptable Referer, rather than allowing it. Webhook
authentication as HMAC over the raw body with a two-directional timestamp
window, a database-backed nonce (a memory cache dies with the process), and
multi-secret rotation. File validation by magic number, not by the
attacker-controlled declared type. Presigned URLs minted only **after** the
tenant check, because a presigned URL is a bearer credential.

Errors return a **code, not a message** — `{ error: { code, reference } }` — so
the browser renders it in the reader's language and no internal detail leaks.
`AppError.internalMessage` is logged and never serialized.

Secrets are validated at boot and the process refuses to start in production
without them. pino redaction covers passwords, tokens and signatures before
serialization; audit metadata is scrubbed independently, because the logger
protects log output and the scrubber protects what is persisted.

Campaign launch has five layers of defence, of which layer 3 — a conditional
claim `SET status='LAUNCHING' WHERE status='READY'` — is the one that actually
prevents double spend. It is tested under genuine database concurrency, and that
test is verified load-bearing: removing the predicate makes it fail with two
winners.

---

## 12. Testing

162 unit and integration tests, 74 end-to-end, run in five CI jobs.

Integration tests run against a **real PostgreSQL as `app_user`**, a role with
neither `SUPERUSER` nor `BYPASSRLS`. That is not a detail: it is what exposed a
production-blocking RLS failure on the entire authentication path, which was
invisible in development because development connected as `postgres`.

Three tests were found to be **vacuous and repaired**:

- The launch-concurrency test passed with the guard removed; instrumentation
  showed the loser was being stopped by a status pre-check, not by the claim. It
  was replaced with a direct two-transaction test and verified to fail when the
  predicate is removed.
- Both i18n catalogue tests flattened keys with dots and so could not see the 26
  unreachable dotted keys.
- The usage-analysis test was proved non-vacuous by injecting a bad key.

A test that cannot fail is worse than no test, because it is counted.

The E2E suite found three real defects: a page with no `<h1>` at all, a `Field`
component whose `cloneElement` put `id` and `aria-*` on a wrapper `<div>` so
`<label for>` pointed at a non-labelable element, and — in this session — a
Playwright configuration that addressed a different database than the server
under test, whose symptoms (403 on every POST, unclearable rate limits) looked
like product bugs.

---

## 13. Performance

Dashboard tiles come from one scan using `FILTER` aggregates rather than five
round trips. Time series fill their gaps, because a line chart that skips empty
days misrepresents a lull as a straight line. Derived rates guard their
denominators and return `null` rather than `NaN` — a NaN leaking into a
dashboard renders as "NaN%".

Nothing loads unbounded: every list endpoint takes `limit`/`offset` with a hard
cap. Media never touches the event loop; `/content` redirects to a presigned URL
rather than proxying megabytes through Node.

The database client and the logger are lazily initialised behind a Proxy, which
serves two purposes: a serverless cold start does not pay for a pool it may
never use, and `next build` needs no runtime configuration — so production
credentials stay out of the build pipeline entirely.

The slowest paths are agent calls, bounded by n8n rather than by this service.
Adding app instances does not make an image generate faster.

---

## 14. Deployment

Multi-stage container on `node:22-alpine`, `output: 'standalone'`, running as
uid 1001, with no source and no dev dependencies in the runtime layer. The
`HEALTHCHECK` hits an endpoint that returns 503 when Postgres is unreachable —
readiness, not merely liveness.

`docker compose up` gives a complete working stack with migrations applied,
MinIO provisioned, and the app connecting as `app_user` — the same
least-privilege posture as production. `N8N_BASE_URL` is deliberately unset so
the UI demonstrates the "integration not configured" state rather than
pretending an agent is available.

CI: typecheck and lint; tests against real Postgres with the RLS-bypass
assertion; E2E in three projects; dependency audit that **fails** on production
advisories and reports dev-only ones without failing; and migration validation
including a `FORCE ROW LEVEL SECURITY` sweep.

Three dependencies were upgraded across majors for advisories found during the
work: Next.js (CVE-2025-66478), drizzle-orm (SQL injection) and next-intl (open
redirect). Production dependencies now carry **0 known vulnerabilities**.

---

## 15. Known limitations

Documented rather than hidden. None is a defect in this platform; most are
properties of the workflows.

| | Status |
|---|---|
| Video generation | Off in the workflow (zero Veo quota). Reported with the reason. |
| Meta performance metrics | No Insights node exists. Reported unavailable, never zeroed. |
| Campaign activation | The workflow has no activation step. Launch reports `PAUSED`. |
| Callbacks | No workflow calls back. Endpoint built, signed, tested, idle. |
| Per-tenant Drive and Meta credentials | Both single-account inside n8n. A workflow change, not a SaaS change. |
| Knowledge document count | Never reported by the workflow. The UI says so rather than showing `0`. |
| Roles beyond ADMIN | Enum and column exist; no permission checks (§10). |
| Billing | Usage metered from day one; no plans, limits or charging (§47). |
| SMTP delivery | `sendEmail` throws rather than pretending to have sent. One function to implement. |
| MFA, SSO/SAML | Not implemented. Neither is blocked by the current model. |
| Malware scanning | Not implemented. Hook point documented at the byte-reading step. |
| Metrics and tracing exporters | Env vars accepted; no exporter wired. Choke points identified. |
| Read replicas | Not wired. Analytics is the natural first candidate. |

---

## 16. Compliance with §52 — no fake implementations

The constraint was: never fake n8n responses, campaign launches, Drive
synchronization, generated media or Meta metrics; never hardcode successful
responses; show an explicit configuration error when an integration is
unavailable.

Held throughout, including where it cost product surface:

- An unconfigured integration produces `integration_not_configured` (503) and a
  localized explanation — never an empty state that reads as "no data yet".
- `agent_requests.n8n_execution_id` stays **null** because no workflow returns
  one, rather than being filled with a plausible value.
- Citations are parsed from the agent's prose and return an **empty list** when
  nothing matches; no source is ever invented.
- `knowledge_sources.document_count` stays null and the UI says so.
- `campaign_metrics` exists, is correct, and is empty; the API reports
  `available: false`.
- Confidence scores are hidden rather than estimated, because the workflow emits
  none.
- The video option is shown and disabled *with its reason*, rather than hidden —
  a user who asked for a video product deserves to know why they cannot have
  one.

---

## 17. Verification performed

| | |
|---|---|
| Tenant isolation | 13 tests, as a non-superuser role |
| Password hashing and policy | 13 |
| Registration, verification, login, reset | 28 |
| Webhook signatures | 18, each written from the attacker's side |
| Campaign approval, launch, idempotency | 22, under database concurrency |
| Agent transport and citation parsing | 38 |
| Localization | 30 |
| End-to-end | 74, three projects, both writing directions |

Additionally verified live against a running server: foreign-Origin and
missing-Origin POSTs rejected 403; unauthenticated tenant reads 401; unsigned
and forged webhooks 401; the rate limiter blocking a sixth registration from one
IP; and the full authentication path against a database connection whose role
reports `rolsuper = f, rolbypassrls = f`.

---

## 18. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Deployed connecting as a superuser | **Critical** — silently removes all RLS | Documented prominently; asserted in CI; the restore procedure re-asserts it |
| n8n unavailable | High — no agents | Explicit error states; the rest of the product works; health reporting |
| n8n's in-memory vector store lost on restart | Medium — stale Knowledge answers for up to 6h | Property of the workflow; documented so a restart is not misdiagnosed |
| A workflow changes shape without notice | Medium | Adapters isolate it; transport tests cover the observed frame shapes |
| Backups never restore-tested | Medium | Procedure and quarterly test documented; not installed by this repo |
| Single Meta ad account across tenants | Medium | Documented; per-tenant credentials require a workflow change |
| Load balancer idle timeout below 5 minutes | Medium — every image generation fails | Called out in the deployment doc |

---

## 19. Cost and usage posture

No billing is implemented (§47), but `usage_records` is written from day one on
every metered event, append-only. The point is that a future plan, limit or
credit system starts with real history rather than with its launch date.

Costs today accrue in n8n (model calls, image generation) and Meta, neither of
which this platform meters directly — it meters the requests that cause them,
which is the closest honest proxy available without an Insights node.

---

## 20. Recommended next steps

In order of value per unit of effort.

1. **Implement SMTP delivery.** One function. Until it exists, verification and
   reset are manual in any real deployment.
2. **Add an Insights node to the advertising workflow** and point it at the
   existing callback endpoint. This is the single change that turns the whole
   analytics surface from "unavailable" into real data — the schema, the
   computations and the endpoint are already built and tested.
3. **Add an activation step** to the advertising workflow, then a deliberate
   "activate" action here with its own approval. Today the last step is manual in
   Ads Manager.
4. **Restore Veo quota** or swap in another video model. The adapter reports the
   capability the moment the workflow provides it; no SaaS change is needed.
5. **Emit callbacks from all three workflows.** Progress reporting becomes real
   rather than polled, and the security work is already done.
6. **Wire an OTLP exporter.** Both choke points already compute the values.
7. **Implement roles.** A permission map plus a call in `route()`.
8. **Move Drive and Meta credentials per tenant.** The largest item on this
   list, and the one that turns a single-account tool into a true SaaS. It is a
   workflow-architecture change first and a SaaS change second.
9. **Malware scanning** at the existing byte-reading step in file validation.
10. **Restore-test the backups**, then put it on a quarterly calendar. A backup
    that has never been restored is a hypothesis.
