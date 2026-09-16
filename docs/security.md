# Security

Controls implemented, why each is shaped the way it is, and what is verified.

---

## Tenant isolation

Two independent controls — PostgreSQL row-level security and a tenant-scoped
repository — with a fail-closed default. Full detail in
[multi-tenancy.md](./multi-tenancy.md).

The deployment requirement bears repeating here: **production must connect as
`app_user`, not a superuser**, because PostgreSQL exempts superusers and
`BYPASSRLS` roles from RLS entirely. CI asserts the test role carries neither
attribute, because otherwise every isolation test would pass against a database
with no policies at all.

---

## Authentication

| Control | Implementation |
|---|---|
| Password hashing | scrypt at OWASP parameters (N=2^17, r=8, p=1), parameters encoded in the hash so cost can be raised later and old hashes upgraded in place on next login. |
| Password screening | NIST SP 800-63B: 12-character minimum, no composition rules, no forced rotation — plus the screening step that is usually skipped. See below. |
| Session tokens | 32 bytes of CSPRNG entropy, stored **only** as SHA-256. A database leak yields hashes, not sessions. |
| Cookie | `__Host-` prefix (browser-enforced Secure + path=/ + no Domain, which forbids a subdomain from overwriting it — session-fixation defence no server check can provide), `httpOnly`, `SameSite=Lax`. |
| Revocation | Immediate and authoritative. This is why sessions are opaque rather than JWTs: a stateless token needs a denylist that reintroduces the same lookup. |
| Brute force | Two independent buckets — per IP and per account. An IP limit alone lets a botnet spread; an account limit alone lets one host enumerate cheaply. Lockout after 5 failures for 15 minutes. |
| Enumeration | Unknown address and wrong password return the identical code, after comparable work: `fakeVerify()` burns an equivalent scrypt cost so latency is not an oracle. Password reset always reports success. |
| Verification | Registration issues no session. The account stays `PENDING_VERIFICATION` until the emailed link is opened, which is what makes verification meaningful rather than decorative. |
| Token hygiene | Single-use, hashed at rest, 24h (verification) / 1h (reset). Issuing a new one invalidates the previous. Consumed only after the state change commits, so a failure leaves the link usable rather than burning it. |
| Reset | Revokes every session, so an attacker holding a stolen session loses it when the owner recovers the account. |

### Password screening

An exact-match block list is not enough. `password1234` is twelve characters of
varied-enough content and sails past a naive check while being among the first
guesses any attacker makes — it was accepted by the first implementation here,
found during live testing.

Screening is now structural: strip the padding people add to a weak base word
(digits, years, punctuation, leetspeak), then judge the alphabetic core by
dominance ratio. Plus word-list-independent checks for sequential runs, repeated
blocks and all-digit passwords.

The normalisation is done twice for a reason. `password1234` needs its digits
**dropped** (they are padding); `p@ssw0rd` needs its digits **translated** (they
stand in for letters). One pass gets one of them wrong — doing leet substitution
before stripping turns `password1234` into `passwordiea`, which matches nothing.
13 tests cover it.

---

## Web security

| Control | Implementation |
|---|---|
| CSRF | `SameSite=Lax` as the primary control, plus an Origin check on every state-changing method. A request with **no** Origin and no acceptable Referer is refused rather than allowed. |
| CSP | `default-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`. `unsafe-eval` only in development. |
| Headers | HSTS with preload, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` denying camera/mic/geolocation, COOP/CORP `same-origin`. |
| XSS | React escapes by default. The single `dangerouslySetInnerHTML` is the theme script, whose content is a module-level constant with no interpolation. |
| SQL injection | Every query is parameterised. The one interpolation site is `SET LOCAL app.organization_id`, which takes no bind parameters — guarded by a strict UUID pattern, with a test that feeds it `' OR '1'='1` and a `DROP TABLE` payload. |
| SSRF | The gateway only ever calls `${N8N_BASE_URL}/webhook/{id}/chat`. The webhook id is validated against `^[A-Za-z0-9_-]+$` so it cannot smuggle a path segment, and `redirect: 'error'` refuses to follow a redirect elsewhere. |
| Rate limiting | Atomic Postgres fixed windows (one `INSERT … ON CONFLICT DO UPDATE`, so two concurrent requests cannot both read `limit - 1`). Chosen over Redis-or-nothing because a limiter that silently no-ops when `REDIS_URL` is unset is worse than none on a login endpoint. |
| Caching | Every tenant response carries `Cache-Control: private, no-store`. |
| Indexing | `robots: noindex, nofollow` — a crawled URL is one more way a link leaks. |

---

## Webhook authentication

`POST /api/v1/webhooks/n8n` is authenticated by HMAC-SHA256 over
`${timestamp}.${nonce}.${rawBody}`:

```
X-AIW-Signature: t=<unix>,n=<nonce>,v1=<hex>
```

| Layer | Stops |
|---|---|
| Rate limit by IP | using the endpoint as a free signature-verification oracle |
| HMAC over the **raw** body | tampering — re-serializing parsed JSON changes key order and breaks every signature, so the route reads the body as text and hands the same string to both the verifier and the parser |
| Timestamp window ±5 min, **both directions** | stale replay, and a far-future signature that would otherwise stay valid forever |
| Nonce with a unique index | replay inside the window — enforced by the database, not a memory cache that dies with the process |
| Constant-time comparison, all candidate secrets tried | recovering the signature by timing, and learning which secret matched |
| Terminal-state check | a late "progress" callback reopening a completed job |

Secrets are an ordered list: index 0 signs, all verify, so rotation is
zero-downtime. Fail-closed: with no secret configured, nothing is trusted.

Every outcome — including every rejection — is recorded in `webhook_deliveries`,
which is what makes failed-callback monitoring possible. The response body says
only "unauthorized"; telling a caller *why* their signature failed helps an
attacker far more than a legitimate integrator, who has the correlation id and
the server logs.

18 tests, each written from the attacker's side.

---

## File security

Every stored file is validated before it is written:

1. **Magic number**, not the declared type or the extension. Both of those are
   attacker-controlled; the first bytes are not.
2. **Allow-list** of six types. Anything else is refused.
3. **Size limits** — 32 MB images, 512 MB video.
4. **Claim vs. content** — a mismatch is the signature of an upload trying to be
   served back as something it is not.

Storage keys are built entirely from generated or validated components
(`tenants/{uuid}/{kind}/{uuid}.{ext}`), so there is no path through which `../`
can enter. Objects are written with `ContentDisposition: attachment` and
`nosniff` — an SVG or HTML served inline from our origin would be stored XSS —
and with SSE-AES256 at rest.

Reads go through short-lived presigned URLs. **The tenant check happens before a
URL is minted**, because once a presigned URL exists it is a bearer credential.

Malware scanning is not implemented; the hook point is documented in
[deployment.md](./deployment.md).

---

## Secrets

| Rule | |
|---|---|
| Validated at boot | The process refuses to start in production with a missing or weak secret, rather than silently falling back to an insecure default. |
| Never in the client bundle | Everything under `src/server/` is server-only. The browser learns the n8n base URL, webhook ids and callback secrets never. |
| Never in logs | pino redaction covers passwords, tokens, keys, cookies, signatures and `authorization`, at two nesting levels. Audit metadata is scrubbed independently — the logger protects log output, the audit scrubber protects what is persisted. |
| Never in a build | The database client and logger are lazily initialised, so `next build` needs no runtime configuration and production credentials stay out of the build pipeline. |
| Rotatable | Callback secrets are a list. `ENCRYPTION_KEY` rotation requires re-encrypting `integrations` (null today). |

---

## Audit trail

Append-only, two ways: `app_user` has no `UPDATE`/`DELETE` privilege, and a
trigger raises `insufficient_privilege` on either — so **even the table owner**
cannot rewrite history.

Each entry records timestamp, tenant, user, preserved actor email, action,
resource type and id, outcome, correlation id, truncated IP, user agent and
scrubbed metadata. Actions are stored as stable keys, never prose, so the trail
renders in the reader's language.

A failure to write an audit row never fails the operation it describes —
refusing a successful login because a log insert timed out is worse than the
missing row — but it is escalated to the system event log as a security-relevant
incident.

Approval and launch write their audit rows **inside** the same transaction as
the state change, because an approved campaign with no audit record is a
compliance gap.

---

## Campaign launch: defence in depth

The highest-stakes path in the product, since it reaches a real ad account.

1. Explicit approval, recording who approved and an **immutable snapshot** of
   exactly what they saw. Any subsequent edit clears the approval.
2. `Idempotency-Key` is **required**, not optional.
3. A conditional claim: `SET status='LAUNCHING' WHERE status='READY'`. Only one
   concurrent caller can match.
4. A partial unique index on `(organization_id, launch_idempotency_key)`.
5. A unique index on `meta_campaign_id`, so even a bug past all of the above
   cannot record two rows against one Meta campaign.

Layer 3 is what prevents double spend; the rest are backstops. It is
[tested under genuine database concurrency](../tests/campaigns/lifecycle.test.ts),
and that test is verified load-bearing — removing the status predicate makes it
fail with two winners instead of one.

---

## Error handling

Users see a localized sentence plus a reference id. They never see a stack
trace, a SQL message or an upstream service name.

`AppError` carries a stable `code` (which doubles as an i18n key) and an
`internalMessage` that is logged and **never** serialized into a response. The
API returns `{ error: { code, reference, params?, fields? } }` — a code, not a
message — so the browser renders it in the reader's language.

---

## Known gaps

Documented rather than hidden:

| Gap | Status |
|---|---|
| Malware scanning of uploads | Not implemented. Hook point documented. |
| MFA / TOTP | Not implemented. The session model supports adding it. |
| OAuth / SSO / SAML | Not implemented. `users` carries no password-only assumption that would block it. |
| Per-tenant Meta and Drive credentials | Both live in n8n, single-account. Requires a workflow change, not a SaaS change. |
| SMTP delivery | `sendEmail` throws rather than pretending to have sent. One function to implement. |
| Dev-only npm advisories | 7 moderate, all inside drizzle-kit's bundled CLI tooling, unreachable from a deployed artifact. Production dependencies: **0 vulnerabilities**. |

---

## Verification summary

| Area | Tests |
|---|---|
| Tenant isolation | 13, as a non-superuser role |
| Password hashing and policy | 13 |
| Registration, verification, login, reset | 28 |
| Webhook signatures | 18 |
| Campaign approval, launch, idempotency | 22 |
| Agent transport and citation parsing | 38 |
| Localization | 30 |
| End-to-end, both directions | 74 |

Additionally verified live against a running server: foreign-Origin and
missing-Origin POSTs rejected 403; unauthenticated tenant reads 401; unsigned
and forged webhooks 401; the rate limiter blocking a sixth registration from one
IP.
