# API

Versioned under `/api/v1`. Every route goes through `route()` in
`src/server/api/handler.ts`, which guarantees a correlation id, an Origin check,
authentication where declared, Zod validation, rate limiting and a consistent
error shape.

---

## The error contract

**The API returns a code, never a message.**

```json
{
  "error": {
    "code": "rate_limited",
    "reference": "cid_vw1AuNL-irhr",
    "params": { "seconds": 30 },
    "fields": [{ "path": "password", "rule": "too_short", "params": { "min": 12 } }]
  }
}
```

The browser renders `errors.<code>` from its own catalogue. That is the only way
one backend serves an Arabic and an English user correctly: the language of the
response is the language of the **reader**, not of whichever server handled it.

`reference` is the correlation id. It appears in the `X-Correlation-Id` header,
on every log line for that request, on the error screen the user sees, and in
`agent_requests` and `audit_logs`. One value ties a user's screenshot to a log
search.

Field errors carry a `rule` (an i18n key under `errors.field.*`) and
interpolation `params` — never prose.

| Code | Status | |
|---|---|---|
| `unauthorized` | 401 | no valid session |
| `forbidden` | 403 | cross-origin, or insufficient permission |
| `invalid_credentials` | 401 | identical for a wrong password and an unknown address |
| `account_locked` | 423 | carries `minutes` |
| `email_not_verified` | 403 | |
| `email_already_registered` | 409 | registration only |
| `invalid_token` / `token_expired` | 400 / 410 | |
| `validation_failed` | 422 | carries `fields` |
| `not_found` | 404 | also returned for another tenant's resource — revealing nothing |
| `conflict` | 409 | |
| `rate_limited` | 429 | carries `seconds`, plus `Retry-After` |
| `payload_too_large` | 413 | |
| `unsupported_media_type` | 415 | |
| `integration_not_configured` | 503 | explicit, never a fabricated success |
| `agent_unavailable` / `agent_timeout` / `agent_failed` | 503 / 504 / 502 | a timeout is distinct because the work may still be running |
| `capability_unavailable` | 501 | the workflow cannot do this |
| `campaign_not_launchable` / `campaign_already_launched` | 409 | |
| `internal_error` | 500 | |

---

## Cross-cutting behaviour

**Authentication** — session cookie. `route()` requires it unless
`auth: false`.

**CSRF** — `SameSite=Lax` plus an Origin check on POST/PUT/PATCH/DELETE. A
request with no Origin and no acceptable Referer is **refused**, not allowed.
The n8n callback opts out (`skipOriginCheck`) because it authenticates with an
HMAC signature instead.

**Rate limiting** — per-user when authenticated, per-IP otherwise.

| Bucket | Limit |
|---|---|
| `login` (IP) / `login_account` (address) | 10 / 5 min · 5 / 15 min |
| `register`, `password_reset`, `email_verification` | 5 / hour |
| `agent` | 60 / min |
| `campaign_launch` | 10 / hour |
| `api` (default) | 300 / min |
| `webhook` | 600 / min |

**Idempotency** — `Idempotency-Key` is honoured on asset generation and
**required** on campaign launch.

**Caching** — every tenant response carries `Cache-Control: private, no-store`.

---

## Endpoints

### Authentication

| | | Auth |
|---|---|---|
| `POST` | `/auth/register` | no |
| `POST` | `/auth/login` | no |
| `POST` | `/auth/logout` | yes |
| `POST` | `/auth/verify-email` | no |
| `POST` | `/auth/request-password-reset` | no |
| `POST` | `/auth/reset-password` | no |

`register` returns `201 { organizationId, email, requiresVerification: true }`
and **issues no session** — the account is `PENDING_VERIFICATION` until the
emailed link is opened.

`request-password-reset` always returns `200 { ok: true }`, whether or not the
address exists. Anything else makes it an account-enumeration oracle.

`verify-email` is a **POST**, not a GET on the link. Mail clients and corporate
gateways fetch URLs eagerly; a GET that consumed the token would burn it before
the recipient clicked.

### Account

| | |
|---|---|
| `PATCH` | `/me/locale` — persists the language preference and mirrors the cookie |
| `PATCH` | `/me/password` — requires the current password; revokes every session |

### Agents

| | |
|---|---|
| `GET` | `/agents` — capabilities, including each `unavailable[]` with its `reasonKey` |

The client renders "not available" states from this, so the product's claims
cannot drift from the workflows' behaviour.

### Knowledge

| | |
|---|---|
| `GET` `POST` | `/knowledge/conversations` |
| `GET` `DELETE` | `/knowledge/conversations/{id}` |
| `POST` | `/knowledge/conversations/{id}/messages` |
| `PATCH` | `/knowledge/messages/{id}/feedback` |

Posting a message returns `200` **with an `error` object** when the agent fails,
rather than a 5xx: the user's question was already saved and the UI must render
it alongside a retry. A 5xx would discard the turn they just typed.

`agentSessionId` is never returned — it is a capability handle for the
workflow's memory.

### Assets

| | |
|---|---|
| `GET` `POST` | `/assets` — list with filters; generate |
| `GET` `DELETE` | `/assets/{id}` |
| `GET` | `/assets/{id}/content` — 302 to a presigned URL |

`/content` redirects rather than proxying: streaming megabytes through Node
would put media on the event loop and make the object store's CDN pointless. The
tenant check happens **before** the URL is minted, because a presigned URL is a
bearer credential.

### Campaigns

| | |
|---|---|
| `GET` `POST` | `/campaigns` |
| `GET` `PATCH` `DELETE` | `/campaigns/{id}` |
| `POST` | `/campaigns/{id}/approve` — body `{ confirmed: true }` |
| `POST` | `/campaigns/{id}/launch` — body `{ confirmed: true }`, **`Idempotency-Key` required** |

`confirmed: true` must be stated explicitly rather than inferred from the call,
so a stray POST cannot approve or launch, and the audit record reflects a
deliberate act.

A successful launch returns `status: 'PAUSED'`, never `'ACTIVE'` — the workflow
creates every Meta object paused and has no activation step.

### Reporting

| | |
|---|---|
| `GET` | `/analytics` — includes `unavailableMetrics[]`, naming what the integrations cannot supply |
| `GET` | `/activity` — audit trail, read-only by construction |
| `GET` | `/jobs` |
| `GET` | `/integrations` — status and identifiers; **no** base URL, webhook ids or credentials |
| `GET` | `/health` — unauthenticated, terse, 503 when the database is unreachable |

`/activity` withholds IP and user agent: they are retained for incident
response, not routine display. `/jobs` withholds `errorDetail`, which is
engineer-facing; the client localizes `errorCode`.

### Webhook

| | |
|---|---|
| `POST` | `/webhooks/n8n` — HMAC-signed, see [security.md](./security.md) |

Receives no traffic today: none of the three workflows calls back. Implemented
and tested so adopting the pattern is a workflow change, not a project.

---

## OpenAPI

`npm run openapi` writes `docs/openapi.json`, generated from the same Zod
schemas the routes validate with — so the document cannot drift from the
implementation.
