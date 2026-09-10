# n8n integration

How the SaaS talks to the three workflows: transport, the gateway, jobs,
idempotency, failure handling, the callback endpoint that nothing calls yet, and
what an operator has to configure.

**What each workflow actually does** — its inputs, its real limits, the five
findings that contradict the brief — is [agent-contracts.md](./agent-contracts.md).
Read that first. This document is the plumbing.

---

## The boundary

```
service ──► invokeAgent() ──► AgentAdapter ──► n8n-client ──► n8n
   │             │                 │
   │             │                 └─ the only code that knows n8n's wire format
   │             └─ audit, jobs, idempotency, usage metering
   └─ domain logic, tenant-scoped
```

Three rules hold this together:

1. **Nothing outside `src/server/agents/` knows n8n exists.** The rest of the
   application speaks `AgentRequest` / `AgentResponse` from `contracts.ts`.
2. **The browser never learns the base URL, a webhook id, or a callback
   secret.** They are read from server-only environment through
   `src/server/config/env.ts` and never serialized into a page or an API
   response — including `/api/v1/integrations`, which reports status and
   identifiers only (§24).
3. **An adapter declares its own limits.** `capabilities()` returns
   `unavailable[]` entries of `{ capability, reasonKey }`, and the UI renders
   those keys. The product's claims cannot drift from the workflows' behaviour
   because they are derived from it.

---

## Transport

All three workflows are `chatTrigger` nodes, so there is exactly one call shape:

```
POST {N8N_BASE_URL}/webhook/{webhookId}/chat
Content-Type: application/json
X-Correlation-Id: {correlationId}
[optional configured auth header]

{ "action": "sendMessage", "sessionId": "...", "chatInput": "...", "files": [...] }
```

`N8N_BASE_URL` is fixed configuration and the webhook id is validated against
`^[A-Za-z0-9_-]+$`, so no caller-supplied value can smuggle in a path segment
and turn the gateway into an SSRF primitive. `redirect: 'error'` means a
redirect to another host is a failure rather than a followed hop.

### Three response formats, one parser

| Mode | Body | Join rule |
|---|---|---|
| `lastNode` | one JSON document | — |
| `streaming` | newline-delimited token frames | concatenate with **no** separator |
| `responseNodes` | one frame per "Respond to Chat" node | join with a **blank line** |

`parseChatFrames` normalises all three (it also tolerates SSE-style `data:`
prefixes and the `event:`/`id:`/`retry:` lines that come with them); `joinFrames`
applies the right join. The distinction is not cosmetic: concatenating whole
messages runs paragraphs together, and blank-line-joining token frames shreds
sentences into fragments. 19 tests in `tests/agents/n8n-client.test.ts` cover the
frame shapes actually observed, including malformed and partial ones.

### Session ids are capability handles

Each workflow keeps a 10-turn `memoryBufferWindow` keyed on `sessionId`. Anyone
holding that value can read and extend that conversation's history, so it is
generated with 24 bytes of entropy, stored in `conversations.agent_session_id`
under a unique index, and **never returned to the browser**.

### Timeouts

`N8N_REQUEST_TIMEOUT_MS` (default 300 000 — five minutes) is enforced with an
`AbortSignal`. Image generation legitimately takes minutes; a 30-second default
would fail every creative request.

An abort maps to `agent_timeout`, which is deliberately a **different code** from
`agent_unavailable`. A timeout means the work may still be running in n8n, so
the UI does not offer a bare "retry" that could produce a second image or a
second Meta campaign.

---

## The gateway

`invokeAgent()` in `src/server/agents/gateway.ts` wraps every call.

**It writes `agent_requests` before the call, not after.** A process that dies
mid-flight still leaves evidence that a request was made. `agent_requests` is
the audit spine for all AI activity and the source of every "requests" figure on
the dashboard; a row written on success only would make the dashboard a record
of successes rather than of activity.

**Correlation is ours.** No workflow returns an execution id, so
`agent_requests.n8n_execution_id` is usually null and honestly left null rather
than filled with something invented. Every call carries `X-Correlation-Id`, and
that value appears in the SaaS logs, in `agent_requests`, in `audit_logs` and in
the reference shown to the user — so matching a user's report to an n8n
execution is a timestamp-and-correlation-value search, which is the best that is
available without a workflow change.

**Long-running work becomes a job.** Job-backed actions insert an `agent_jobs`
row in `PROCESSING` and settle it `COMPLETED` or `FAILED`. The UI polls
`/api/v1/jobs`.

**Idempotency is per tenant.** When a job-backed action is invoked twice with the
same `Idempotency-Key`, the second call returns the original job instead of
running again:

```sql
-- partial unique index
(organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL
```

Scoping to the tenant is what lets two organizations pick the same key without
colliding. Campaign launch **requires** the header; asset generation honours it
when supplied.

**Usage is metered on every invocation** (§47), into the append-only
`usage_records`. No billing logic is implemented — the point is that a future
plan or credit system starts with real history instead of a launch date.

---

## Failure handling

Everything the workflows can do to us maps to an explicit code. Nothing is
smoothed into a fake success (§52).

| Situation | Code | Status |
|---|---|---|
| `N8N_BASE_URL` or the webhook id is unset | `integration_not_configured` | 503 |
| Connection refused, DNS failure, TLS failure, redirect | `agent_unavailable` | 503 |
| n8n answered 4xx | `agent_unavailable` | 503 |
| n8n answered 5xx | `agent_failed` | 502 |
| The request exceeded the timeout | `agent_timeout` | 504 |
| The workflow ran but the result is unusable | `agent_failed` | 502 |
| The workflow cannot do this at all (video) | `capability_unavailable` | 501 |

`integration_not_configured` is the one worth dwelling on. A missing n8n
configuration produces an explicit, localized "this integration is not
configured" screen — never an empty state that looks like "you have no data
yet", and never a stubbed response. The same rule holds for storage, for Drive
and for Meta.

There is **no automatic retry**. Every one of these calls can spend money or
produce a stored artefact, and a generic retry wrapper in front of a workflow
that creates Meta objects is a duplicate-spend generator. Retries are a user
action, guarded by idempotency keys.

Posting a chat message is the one endpoint that returns `200` carrying an
`error` object rather than a 5xx: the user's question is already persisted, and
the UI has to render it alongside a retry. A 5xx would discard the turn they
just typed.

---

## The callback endpoint

`POST /api/v1/webhooks/n8n` is fully implemented, fully tested, and **receives
no traffic**, because none of the three workflows has a node that calls back
(finding 2 in [agent-contracts.md](./agent-contracts.md)).

It is here so that adopting the pattern is a workflow change rather than a
project, and so the security work is finished before the first callback arrives
rather than after.

Accepted events:

```
agent.progress   agent.completed   agent.failed
knowledge.sync.started   knowledge.sync.completed   knowledge.sync.failed
```

Authentication is HMAC-SHA256 over `${timestamp}.${nonce}.${rawBody}`:

```
X-AIW-Signature: t=<unix>,n=<nonce>,v1=<hex>
```

The full control-by-control rationale is in [security.md](./security.md). The
integration-facing summary:

- Sign the **raw body bytes**. Re-serializing parsed JSON changes key order and
  breaks every signature; the route hands the same string to the verifier and
  the parser.
- The timestamp window is ±5 minutes in **both** directions, so a far-future
  signature does not stay valid indefinitely.
- The nonce is a unique index in `webhook_deliveries` — replay protection that
  survives a process restart, which an in-memory cache does not.
- `N8N_CALLBACK_SECRETS` is a comma-separated list: index 0 signs, all values
  verify, so rotation is zero-downtime. With none configured, nothing is
  trusted.
- Application is idempotent and refuses to reopen a terminal job — a late
  "progress" callback cannot un-complete finished work.

Every outcome, **including every rejection**, is recorded in
`webhook_deliveries`. That table is what makes failed-callback monitoring
possible. The response body says only `unauthorized`; explaining *why* a
signature failed helps an attacker more than a legitimate integrator, who has
the correlation id and the server logs.

### Adding a callback to a workflow

1. Add an HTTP Request node posting the JSON above to
   `{APP_URL}/api/v1/webhooks/n8n`.
2. Compute the signature over the raw body with a secret from
   `N8N_CALLBACK_SECRETS`.
3. Send back the `request_id` the gateway supplied, so the event can be
   attributed to an `agent_requests` row.

Nothing in the SaaS changes.

---

## Configuration

| Variable | |
|---|---|
| `N8N_BASE_URL` | Instance root. The gateway appends `/webhook/{id}/chat` and nothing else. |
| `N8N_KNOWLEDGE_WEBHOOK_ID` `N8N_CREATIVE_WEBHOOK_ID` `N8N_ADVERTISING_WEBHOOK_ID` | Chat-trigger webhook ids. |
| `N8N_*_WORKFLOW_ID` | Operator-facing only: health reporting and links into the n8n editor. Never used to build a call. |
| `N8N_WEBHOOK_AUTH_HEADER` / `_VALUE` | Optional header auth, if the webhooks are protected. |
| `N8N_REQUEST_TIMEOUT_MS` | Default 300 000. |
| `N8N_CALLBACK_SECRETS` | Comma-separated; first signs, all verify. |

`isN8nConfigured()` gates the feature. `/api/v1/health` reports n8n as
`configured` or `not_configured` — a **configuration fact, not a probe**, so an
unauthenticated caller cannot make this service call out to a third party.

`probeN8n()` does perform a real reachability check with a 5-second timeout, and
is used only by authenticated operator surfaces.

---

## Credential ownership

**This application stores no third-party credential.** Google Drive OAuth and
the Meta Graph token both live in n8n's credential store, and both are
single-account (§53's per-tenant credential model is a workflow change, not a
SaaS change).

The Settings page states where each credential actually lives rather than
implying this workspace holds a token it has never seen.
`integrations.encrypted_credentials` exists, is AES-256-GCM at rest, and is null
today.

---

## Replacing n8n

Write three adapters against `AgentAdapter` in `contracts.ts`. Nothing else
changes — not a service, not a page, not a table.

An adapter must also report its limits through `capabilities()`. That is what
makes the swap complete rather than cosmetic: a replacement that *can* generate
video turns the Creative Studio's video option on by reporting that it can, and
a replacement that can read Meta Insights turns campaign performance on the same
way.
