# Observability

Four signals, each with a different audience and a different retention need:

| | Audience | Where |
|---|---|---|
| **Logs** | engineers | structured JSON on stdout |
| **Audit trail** | tenant admins, compliance | `audit_logs`, surfaced at `/activity` |
| **System events** | platform operators | `system_events` |
| **Usage records** | future billing | `usage_records` |

They are separate on purpose. Log retention is an operational choice; audit
retention is a compliance obligation; and a tenant's activity page must not
depend on whether someone renewed the log-aggregation contract.

---

## The correlation id

One value ties everything together.

```
cid_vw1AuNL-irhr
```

Generated per request in `route()` — or adopted from an inbound
`X-Correlation-Id` when it matches `^cid_[A-Za-z0-9_-]{1,32}$`, so a trusted
caller's id survives the hop but an attacker cannot inject arbitrary text into
log lines.

It appears in:

- the `X-Correlation-Id` response header, on success and on failure;
- every log line for that request, via a child logger;
- the `reference` field of every API error;
- the error screen the user sees;
- `agent_requests.correlation_id` and `audit_logs.correlation_id`;
- the `X-Correlation-Id` header sent to n8n.

That is the whole point of the design: a user sends a screenshot with a
reference on it, and one search returns the request, the tenant, the agent call
and the audit row.

Since no workflow returns an execution id, this is also the only way to match a
SaaS request to an n8n execution — by correlation value and timestamp.

---

## Logs

pino, JSON, on stdout. `LOG_LEVEL` controls verbosity; `silent` in tests.

Every line carries `service`, `env`, `level`, an ISO timestamp and
`correlationId`. Authenticated requests add `tenantId` and `userId` through a
child logger, so filtering to one tenant's traffic is a field match rather than
a text search.

### Redaction is a security control

§32 forbids logging passwords, tokens, API keys and OAuth secrets. That is
enforced by pino's `redact`, which runs **before serialization** — a secret that
lands in a log object never reaches a transport, a file or an aggregator.

The list covers `password`, `passwordHash`, `newPassword`, `currentPassword`,
`token`, `tokenHash`, `sessionToken`, `refreshToken`, `accessToken`, `apiKey`,
`secret`, `clientSecret`, `authorization`, `cookie`, `setCookie` and
`signature`, plus one level of nesting and the specific header paths
(`req.headers.authorization`, `req.headers.cookie`,
`req.headers["x-aiw-signature"]`).

Audit metadata is scrubbed **independently**, by `sanitizeMetadata`. The two are
not redundant: the logger protects log output, the scrubber protects what is
persisted in the database.

### Levels

| | |
|---|---|
| `warn` | An expected rejection — validation, rate limit, wrong password. `{ code, detail }`, no stack. |
| `error` | An unexpected failure. Adds the cause's stack. |

The split matters for alerting. A thousand `warn` lines a minute means users are
mistyping passwords; a thousand `error` lines means something is broken. Alert
on `error` rate and on `code`, not on log volume.

`AppError.internalMessage` is logged and is **never** serialized into a
response. The client gets a code; the log gets the reason.

---

## Audit trail

`audit_logs`, append-only two ways: `app_user` holds no `UPDATE` or `DELETE`
privilege, and a trigger raises `insufficient_privilege` on either — so even the
table owner cannot rewrite history.

Each row records timestamp, tenant, user, the actor's email preserved as text
(so the trail survives the user being deleted), action, resource type and id,
outcome, correlation id, truncated IP, user agent and scrubbed metadata.

**Actions are stable keys, never prose** — `auth.login`, `campaign.launch` —
which is what lets the same row render in Arabic for one reader and English for
another.

Two properties are worth knowing when reading it:

- A failure to write an audit row **never fails the operation it describes**.
  Refusing a successful login because a log insert timed out is worse than the
  missing row. The failure is escalated to `system_events` as
  `audit_write_failed`, so the gap is itself recorded.
- Approval and launch write their audit rows **inside** the same transaction as
  the state change. An approved campaign with no audit record is a compliance
  gap, and those are the two actions where that matters most.

`/activity` renders it, filterable by action, user, resource and date.
It withholds IP and user agent: those are retained for incident response, not
for routine display.

---

## System events

`system_events` is platform health, deliberately distinct from the tenant audit
trail. Severity `INFO` / `WARN` / `ERROR`, a `source`, a stable `code`, optional
detail, correlation id and scrubbed metadata.

Its tenant is **nullable**, because some events genuinely belong to no tenant —
n8n unreachable, a rejected callback that could not be attributed. The RLS
policy admits `organization_id IS NULL` rows for exactly that case, and those
rows are written unscoped.

Codes worth alerting on:

| | |
|---|---|
| `audit_write_failed` | The audit trail has a hole. Security-relevant. |
| n8n unreachable | The agents are down for everyone. |
| Webhook rejections | Either a misconfigured workflow or someone probing the endpoint. |

---

## Agent requests

`agent_requests` is the audit spine for all AI activity, written **before** the
call so a process that dies mid-flight still leaves evidence. It carries the
agent, the action, the tenant, the user, the correlation id, the outcome,
duration and — when a workflow ever supplies one — `n8n_execution_id`.

It is the source of every "requests" figure on the dashboard. Because the row is
written before rather than after, those figures count activity, not successes.

`agent_jobs` tracks long-running work through `PROCESSING` →
`COMPLETED`/`FAILED`. `/api/v1/jobs` exposes it, withholding `errorDetail`,
which is engineer-facing; the client localizes `errorCode`.

---

## Webhook deliveries

`webhook_deliveries` records **every** inbound callback, including every
rejection, with its nonce, its outcome and the reason. Two jobs: the unique
index on `nonce` *is* the replay guard, and the rejection rows are what make
"callbacks are failing" a query rather than a guess.

---

## Health

`GET /api/v1/health` — unauthenticated, terse, no version string, no hostname,
no dependency addresses, no error detail.

```json
{
  "status": "ok",
  "checks": { "database": "ok", "n8n": "configured", "storage": "configured" },
  "latencyMs": 3
}
```

The database check is a real query and gates the status: **503 when Postgres is
unreachable**, so an orchestrator pulls the instance from the pool. That is
readiness, not merely liveness.

n8n and storage report **configuration facts, not probe results**. Probing them
here would let an unauthenticated caller make this service call out to third
parties on demand.

---

## Metrics and tracing

`SENTRY_DSN` and `OTEL_EXPORTER_OTLP_ENDPOINT` are accepted and validated;
**no exporter is wired up**. Saying so plainly is better than shipping a
`metrics.ts` that increments counters nobody collects.

What exists in the meantime is not nothing: structured logs with a correlation
id and consistent field names support latency and error-rate queries in any
aggregator, and `agent_requests` holds real per-call durations that
`/api/v1/analytics` already reports.

Where to add it, when it is added: `route()` in `src/server/api/handler.ts` is
the single choke point for HTTP timing and outcome, and `invokeAgent()` is the
single choke point for agent latency. Both already compute the values.

---

## Product analytics

`/api/v1/analytics` reports from real tables only, and says what it cannot
report.

The response carries an `unavailableMetrics[]` array naming each metric the
integrations cannot supply, with a reason key. Meta performance — impressions,
clicks, CTR, CPC, conversions, ROAS — is in that list, because the advertising
workflow has no Insights node. The UI renders the explanation.

Zeros would be worse than an absence: "0 impressions" reads as "nobody saw this
ad", which is a claim about the world rather than about our integration.

`campaign_metrics` exists and every derived rate is computed correctly, guarding
its denominators so `ctr`, `cpcMinor` and `roas` return `null` rather than `NaN`
or `Infinity` — a NaN leaking into a dashboard renders as "NaN%". Nothing writes
to the table today. The day a workflow does, the schema needs no migration.

---

## Runbook sketch

| Symptom | Look at |
|---|---|
| Users report an error id | `correlationId` across logs, `agent_requests`, `audit_logs` |
| Agents failing for everyone | `system_events` for n8n codes; `/api/v1/health`; n8n's own execution list |
| One tenant sees stale data | that tenant's `agent_jobs` for stuck `PROCESSING` rows |
| Callbacks not arriving | `webhook_deliveries` — an empty table means nothing arrived; rejection rows mean signatures are failing |
| Login failures spiking | `warn` lines with `code: invalid_credentials`, grouped by IP; `rate_limits` |
| Audit gap suspected | `system_events` for `audit_write_failed` |
