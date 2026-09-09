import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { withTenant, withoutTenantScope } from '@/server/tenancy/context';
import {
  webhookDeliveries,
  agentRequests,
  agentJobs,
  knowledgeSources,
  knowledgeSyncs,
} from '@/server/db/schema';
import {
  verifyWebhookSignature,
  SIGNATURE_HEADER,
  MAX_CLOCK_SKEW_SECONDS,
} from '@/server/security/webhook-signature';
import { correlationId as newCorrelationId } from '@/lib/ids';
import { requestLogger } from '@/server/observability/logger';
import { recordSystemEvent } from '@/server/services/audit';
import { consumeRateLimit, POLICIES, clientIp } from '@/server/security/rate-limit';

/**
 * Inbound n8n callback endpoint (§28, §29).
 *
 * IMPORTANT CONTEXT: none of the three production workflows calls this endpoint
 * today. They are synchronous chat-trigger webhooks with no callback step — see
 * docs/n8n-integration.md. It exists because §24's architecture requires a
 * secured callback path, and because the moment a workflow gains a "notify the
 * SaaS" node, this is what it must talk to. It is fully implemented and tested
 * rather than stubbed, so adopting it is a workflow change only.
 *
 * This route is deliberately NOT built on `route()`: it authenticates with an
 * HMAC signature rather than a session cookie, so the Origin check and session
 * requirement do not apply, and it must read the RAW body before parsing.
 *
 * Defence layers, in the order they run:
 *  1. Rate limit by IP — an unauthenticated endpoint must not be a free
 *     signature-verification oracle.
 *  2. HMAC signature over `${timestamp}.${nonce}.${rawBody}`, constant-time.
 *  3. Timestamp window (±5 minutes).
 *  4. Nonce uniqueness, enforced by a unique index — this is what actually
 *     stops a replay, not a memory cache that dies with the process.
 *  5. Idempotent application: a second callback for a request already in a
 *     terminal state is acknowledged and ignored.
 *
 * Every outcome, including every rejection, is recorded in webhook_deliveries
 * so failed-callback monitoring (§34) has real data.
 */

/** How long a nonce is retained. Must exceed the accepted clock skew. */
const NONCE_RETENTION_MS = (MAX_CLOCK_SKEW_SECONDS + 60) * 1000;

const callbackSchema = z.object({
  /** The `req_…` value the gateway sent as `request_id`. */
  requestId: z.string().min(1).max(128),
  event: z.enum([
    'agent.progress',
    'agent.completed',
    'agent.failed',
    'knowledge.sync.started',
    'knowledge.sync.completed',
    'knowledge.sync.failed',
  ]),
  /** n8n's own execution id, when the workflow chooses to send it. */
  executionId: z.string().max(128).optional(),
  progress: z.number().int().min(0).max(100).optional(),
  result: z.record(z.unknown()).optional(),
  error: z
    .object({
      code: z.string().max(120).optional(),
      message: z.string().max(4000).optional(),
    })
    .optional(),
  /** Present on knowledge.sync.* events. */
  sync: z
    .object({
      sourceExternalId: z.string().max(256).optional(),
      documentsIndexed: z.number().int().min(0).optional(),
      documentsFailed: z.number().int().min(0).optional(),
    })
    .optional(),
});

const MAX_BODY_BYTES = 512 * 1024;

async function recordDelivery(params: {
  nonce: string;
  requestRef?: string;
  event: string;
  outcome: 'ACCEPTED' | 'DUPLICATE' | 'REJECTED';
  rejectionReason?: string;
  organizationId?: string;
  correlationId: string;
}): Promise<boolean> {
  try {
    // The unique index on `nonce` is the replay guard. A conflict means this
    // exact signed payload has been seen before.
    const inserted = await db
      .insert(webhookDeliveries)
      .values({
        organizationId: params.organizationId ?? null,
        nonce: params.nonce,
        requestRef: params.requestRef ?? null,
        event: params.event,
        outcome: params.outcome,
        rejectionReason: params.rejectionReason ?? null,
        correlationId: params.correlationId,
        expiresAt: new Date(Date.now() + NONCE_RETENTION_MS),
      })
      .onConflictDoNothing({ target: webhookDeliveries.nonce })
      .returning({ id: webhookDeliveries.id });

    return inserted.length > 0;
  } catch {
    // A delivery-log failure must not become an accepted-but-unlogged callback.
    return false;
  }
}

function reject(
  status: number,
  reason: string,
  correlationId: string,
): NextResponse {
  // The body says only "rejected". Telling a caller *why* their signature
  // failed helps an attacker far more than it helps a legitimate integrator,
  // who has the correlation id and the server logs.
  return NextResponse.json(
    { error: { code: 'unauthorized', reference: correlationId } },
    { status, headers: { 'X-Correlation-Id': correlationId, 'Cache-Control': 'no-store' } },
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const correlationId =
    request.headers.get('x-correlation-id')?.match(/^cid_[A-Za-z0-9_-]{1,32}$/)?.[0] ??
    newCorrelationId();
  const log = requestLogger({ correlationId, route: '/api/v1/webhooks/n8n', method: 'POST' });
  const ip = clientIp(request.headers);

  // --- 1. Rate limit -------------------------------------------------------
  const limit = await consumeRateLimit(POLICIES.webhook, `ip:${ip}`);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: { code: 'rate_limited', reference: correlationId } },
      {
        status: 429,
        headers: {
          'Retry-After': String(limit.retryAfterSeconds),
          'X-Correlation-Id': correlationId,
        },
      },
    );
  }

  // --- 2. Read the raw body ------------------------------------------------
  // The signature covers these exact bytes. Re-serializing parsed JSON would
  // change key order and whitespace and break every signature.
  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    log.warn({ size: rawBody.length }, 'callback body too large');
    return reject(413, 'payload_too_large', correlationId);
  }

  // --- 3. Verify the signature --------------------------------------------
  const verification = verifyWebhookSignature(
    request.headers.get(SIGNATURE_HEADER),
    rawBody,
  );

  if (!verification.ok) {
    log.warn({ reason: verification.reason, ip }, 'rejected n8n callback');

    await recordSystemEvent({
      severity: 'WARN',
      source: 'webhook',
      code: 'callback_rejected',
      detail: verification.reason,
      correlationId,
      metadata: { ip },
    });

    return reject(401, verification.reason, correlationId);
  }

  const { nonce } = verification.parsed;

  // --- 4. Parse and validate ----------------------------------------------
  let payload: z.infer<typeof callbackSchema>;
  try {
    payload = callbackSchema.parse(JSON.parse(rawBody));
  } catch (error) {
    await recordDelivery({
      nonce,
      event: 'unknown',
      outcome: 'REJECTED',
      rejectionReason: 'invalid_payload',
      correlationId,
    });
    log.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'callback payload failed validation',
    );
    return NextResponse.json(
      { error: { code: 'validation_failed', reference: correlationId } },
      { status: 422, headers: { 'X-Correlation-Id': correlationId } },
    );
  }

  // --- 5. Resolve the tenant from the request reference --------------------
  // Runs unscoped by necessity: the tenant is what we are looking up. It reads
  // one indexed column and returns only ids.
  const requestRows = await withoutTenantScope('webhook:resolve-tenant', (tx) =>
    tx
      .select({
        id: agentRequests.id,
        organizationId: agentRequests.organizationId,
        status: agentRequests.status,
      })
      .from(agentRequests)
      .where(eq(agentRequests.requestRef, payload.requestId))
      .limit(1),
  );

  const agentRequest = requestRows[0];

  // A sync event carries no agent request; it is attributed by folder id.
  const isSyncEvent = payload.event.startsWith('knowledge.sync');

  if (!agentRequest && !isSyncEvent) {
    await recordDelivery({
      nonce,
      requestRef: payload.requestId,
      event: payload.event,
      outcome: 'REJECTED',
      rejectionReason: 'unknown_request',
      correlationId,
    });
    log.warn({ requestId: payload.requestId }, 'callback for an unknown request');
    // 404 rather than 401: the signature was valid, so this is a real
    // integration telling us about something we have no record of.
    return NextResponse.json(
      { error: { code: 'not_found', reference: correlationId } },
      { status: 404, headers: { 'X-Correlation-Id': correlationId } },
    );
  }

  // --- 6. Replay check -----------------------------------------------------
  const isFirstDelivery = await recordDelivery({
    nonce,
    requestRef: payload.requestId,
    event: payload.event,
    outcome: 'ACCEPTED',
    organizationId: agentRequest?.organizationId,
    correlationId,
  });

  if (!isFirstDelivery) {
    log.info({ nonce, requestId: payload.requestId }, 'replayed callback ignored');
    // 200, not an error: a well-behaved sender retrying after a timeout should
    // see success and stop, not escalate.
    return NextResponse.json(
      { ok: true, duplicate: true },
      { status: 200, headers: { 'X-Correlation-Id': correlationId } },
    );
  }

  // --- 7. Apply ------------------------------------------------------------
  try {
    if (isSyncEvent) {
      await applySyncEvent(payload, correlationId);
    } else if (agentRequest) {
      await applyAgentEvent(agentRequest, payload, correlationId);
    }
  } catch (error) {
    log.error(
      { err: error instanceof Error ? error.message : String(error), requestId: payload.requestId },
      'failed to apply callback',
    );

    await recordSystemEvent({
      organizationId: agentRequest?.organizationId,
      severity: 'ERROR',
      source: 'webhook',
      code: 'callback_apply_failed',
      detail: error instanceof Error ? error.message : String(error),
      correlationId,
    });

    // 500 so the sender retries. The nonce is already recorded, so the retry
    // will carry a fresh nonce and be processed rather than deduplicated away.
    return NextResponse.json(
      { error: { code: 'internal_error', reference: correlationId } },
      { status: 500, headers: { 'X-Correlation-Id': correlationId } },
    );
  }

  log.info({ event: payload.event, requestId: payload.requestId }, 'callback applied');

  return NextResponse.json(
    { ok: true },
    { status: 200, headers: { 'X-Correlation-Id': correlationId } },
  );
}

async function applyAgentEvent(
  agentRequest: { id: string; organizationId: string; status: string },
  payload: z.infer<typeof callbackSchema>,
  correlationId: string,
): Promise<void> {
  // Idempotency: a request already in a terminal state is not moved again, so a
  // late "progress" callback cannot reopen a completed job.
  const terminal = agentRequest.status === 'COMPLETED' || agentRequest.status === 'FAILED';
  if (terminal && payload.event !== 'agent.progress') return;

  await withTenant({ organizationId: agentRequest.organizationId }, async (tx) => {
    if (payload.event === 'agent.progress') {
      if (terminal) return;
      await tx
        .update(agentJobs)
        .set({
          status: 'PROCESSING',
          progress: payload.progress ?? 0,
          n8nExecutionId: payload.executionId ?? null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(agentJobs.agentRequestId, agentRequest.id),
            eq(agentJobs.organizationId, agentRequest.organizationId),
          ),
        );
      return;
    }

    const completed = payload.event === 'agent.completed';
    const now = new Date();

    await tx
      .update(agentRequests)
      .set({
        status: completed ? 'COMPLETED' : 'FAILED',
        result: completed ? (payload.result ?? {}) : null,
        errorCode: payload.error?.code ?? (completed ? null : 'agent_failed'),
        errorDetail: payload.error?.message?.slice(0, 4000) ?? null,
        n8nExecutionId: payload.executionId ?? null,
        completedAt: now,
      })
      .where(eq(agentRequests.id, agentRequest.id));

    await tx
      .update(agentJobs)
      .set({
        status: completed ? 'COMPLETED' : 'FAILED',
        progress: completed ? 100 : 0,
        output: completed ? (payload.result ?? {}) : null,
        errorCode: payload.error?.code ?? (completed ? null : 'agent_failed'),
        errorDetail: payload.error?.message?.slice(0, 4000) ?? null,
        n8nExecutionId: payload.executionId ?? null,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(agentJobs.agentRequestId, agentRequest.id),
          eq(agentJobs.organizationId, agentRequest.organizationId),
        ),
      );
  });

  void correlationId;
}

/**
 * Applies a Google Drive sync event.
 *
 * The tenant is resolved from the folder id the workflow indexes. Today that
 * folder is shared across tenants (one n8n credential, one folder), so every
 * tenant watching it gets the same status — which is the honest representation
 * of a single shared index. Per-tenant Drive folders need a workflow change;
 * see docs/n8n-integration.md.
 */
async function applySyncEvent(
  payload: z.infer<typeof callbackSchema>,
  correlationId: string,
): Promise<void> {
  const externalId = payload.sync?.sourceExternalId;
  if (!externalId) return;

  const sources = await withoutTenantScope('webhook:resolve-tenant', (tx) =>
    tx
      .select({
        id: knowledgeSources.id,
        organizationId: knowledgeSources.organizationId,
      })
      .from(knowledgeSources)
      .where(eq(knowledgeSources.externalId, externalId)),
  );

  const status =
    payload.event === 'knowledge.sync.completed'
      ? 'SUCCEEDED'
      : payload.event === 'knowledge.sync.failed'
        ? 'FAILED'
        : 'RUNNING';

  for (const source of sources) {
    await withTenant({ organizationId: source.organizationId }, async (tx) => {
      await tx.insert(knowledgeSyncs).values({
        organizationId: source.organizationId,
        knowledgeSourceId: source.id,
        status,
        trigger: 'SCHEDULE',
        documentsIndexed: payload.sync?.documentsIndexed ?? null,
        documentsFailed: payload.sync?.documentsFailed ?? null,
        errorCode: payload.error?.code ?? null,
        errorDetail: payload.error?.message?.slice(0, 4000) ?? null,
        correlationId,
        completedAt: status === 'RUNNING' ? null : new Date(),
      });

      if (status !== 'RUNNING') {
        await tx
          .update(knowledgeSources)
          .set({
            lastSyncedAt: new Date(),
            lastSyncStatus: status,
            // Only recorded when the workflow actually reports a count.
            ...(payload.sync?.documentsIndexed !== undefined
              ? { documentCount: payload.sync.documentsIndexed }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(knowledgeSources.id, source.id));
      }
    });
  }
}
