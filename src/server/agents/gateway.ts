import { and, eq } from 'drizzle-orm';
import { withTenant } from '@/server/tenancy/context';
import { agentRequests, agentJobs, usageRecords } from '@/server/db/schema';
import { requestId as newRequestId } from '@/lib/ids';
import { AppError, toAppError } from '@/lib/errors';
import { env } from '@/server/config/env';
import { logger } from '@/server/observability/logger';
import type { Locale } from '@/i18n/config';
import { knowledgeAgentAdapter } from './adapters/knowledge';
import { creativeAgentAdapter } from './adapters/creative';
import { advertisingAgentAdapter } from './adapters/advertising';
import type {
  AgentAction,
  AgentAdapter,
  AgentCapabilities,
  AgentName,
  AgentRequest,
  AgentResponse,
} from './contracts';

/**
 * The Agent Gateway (§25).
 *
 * One entry point for every AI invocation in the product. It owns the concerns
 * that must not be duplicated per agent:
 *
 *  - Persisting an `agent_requests` row before the call and completing it
 *    after, so the dashboard's request counts come from real records rather
 *    than a counter that can drift.
 *  - Job creation for asynchronous-looking work, with per-tenant idempotency.
 *  - Usage metering (§47).
 *  - Structured logging under one correlation id.
 *
 * Adapters below it know about n8n. Callers above it know only the contract.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- The registry is
   heterogeneous by design: each adapter has its own payload and result types,
   and `invoke` re-establishes that pairing through its own generics. */
const ADAPTERS: Record<AgentName, AgentAdapter<any, any>> = {
  KNOWLEDGE_AGENT: knowledgeAgentAdapter,
  CREATIVE_AGENT: creativeAgentAdapter,
  ADVERTISING_AGENT: advertisingAgentAdapter,
};
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Which agent services which action. */
const AGENT_BY_ACTION: Record<AgentAction, AgentName> = {
  'knowledge.ask': 'KNOWLEDGE_AGENT',
  'creative.generate': 'CREATIVE_AGENT',
  'advertising.submit_campaign': 'ADVERTISING_AGENT',
};

/** Actions whose work is tracked as a user-visible job (§27). */
const JOB_BACKED_ACTIONS = new Set<AgentAction>([
  'creative.generate',
  'advertising.submit_campaign',
]);

export function getAdapter(agent: AgentName): AgentAdapter {
  return ADAPTERS[agent];
}

export function allCapabilities(): AgentCapabilities[] {
  return Object.values(ADAPTERS).map((adapter) => adapter.capabilities());
}

export function capabilitiesFor(agent: AgentName): AgentCapabilities {
  return ADAPTERS[agent].capabilities();
}

export interface InvokeOptions<TPayload> {
  organizationId: string;
  userId: string;
  action: AgentAction;
  locale: Locale;
  payload: TPayload;
  correlationId: string;
  /**
   * Per-tenant idempotency key. When a job-backed action is invoked twice with
   * the same key, the second call returns the first job instead of running the
   * agent again — the control that stops a retried request from creating a
   * second Meta campaign (§29).
   */
  idempotencyKey?: string;
  /** Extra context recorded on the request row. Never sent to the agent. */
  metadata?: Record<string, unknown>;
}

export interface InvokeResult<TResult> {
  requestRef: string;
  jobId?: string;
  response: AgentResponse<TResult>;
}

/** Redacts anything an agent payload should never persist verbatim. */
function sanitizePayload(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object') return {};

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    // Creative bytes are large and belong in object storage, not a jsonb column.
    if (key === 'creative' && value && typeof value === 'object') {
      const creative = value as Record<string, unknown>;
      out[key] = {
        fileName: creative.fileName,
        mimeType: creative.mimeType,
        sizeBytes:
          typeof creative.base64 === 'string'
            ? Math.floor((creative.base64.length * 3) / 4)
            : undefined,
      };
      continue;
    }
    if (key === 'base64' || key === 'data') continue;
    out[key] = value;
  }
  return out;
}

/** Records the meter rows an action produces. */
function usageMetricsFor(
  action: AgentAction,
  response: AgentResponse<unknown>,
): Array<'AGENT_REQUEST' | 'KNOWLEDGE_QUERY' | 'IMAGE_GENERATED' | 'VIDEO_GENERATED' | 'CAMPAIGN_LAUNCH_SUBMITTED'> {
  const metrics: Array<
    'AGENT_REQUEST' | 'KNOWLEDGE_QUERY' | 'IMAGE_GENERATED' | 'VIDEO_GENERATED' | 'CAMPAIGN_LAUNCH_SUBMITTED'
  > = ['AGENT_REQUEST'];

  if (response.outcome !== 'COMPLETED') return metrics;

  switch (action) {
    case 'knowledge.ask':
      metrics.push('KNOWLEDGE_QUERY');
      break;
    case 'creative.generate': {
      const result = response.result as { producedKind?: string } | undefined;
      // Metered by what was produced, not what was requested — a downgraded
      // video request generated an image and is billed as one.
      metrics.push(result?.producedKind === 'VIDEO' ? 'VIDEO_GENERATED' : 'IMAGE_GENERATED');
      break;
    }
    case 'advertising.submit_campaign':
      metrics.push('CAMPAIGN_LAUNCH_SUBMITTED');
      break;
  }

  return metrics;
}

/**
 * Runs an agent, recording the attempt whether it succeeds or fails.
 *
 * The persistence is deliberately split around the call: the request row is
 * committed *before* the agent runs, so a process that dies mid-call still
 * leaves evidence a request was made. Anything else makes a crash look like
 * something that never happened.
 */
export async function invokeAgent<TPayload, TResult>(
  options: InvokeOptions<TPayload>,
): Promise<InvokeResult<TResult>> {
  const agent = AGENT_BY_ACTION[options.action];
  if (!agent) {
    throw new AppError('validation_failed', {
      internalMessage: `Unknown agent action: ${options.action}`,
    });
  }

  const adapter = ADAPTERS[agent];
  if (!adapter.isConfigured()) {
    throw new AppError('integration_not_configured', {
      internalMessage: `${agent} is not configured`,
    });
  }

  const isJobBacked = JOB_BACKED_ACTIONS.has(options.action);
  const log = logger.child({
    correlationId: options.correlationId,
    tenantId: options.organizationId,
    agent,
    action: options.action,
  });

  // --- Idempotency check ---------------------------------------------------
  // Done before any work so a duplicate never reaches the agent at all.
  if (isJobBacked && options.idempotencyKey) {
    const existing = await withTenant(
      { organizationId: options.organizationId, userId: options.userId },
      (tx) =>
        tx
          .select()
          .from(agentJobs)
          .where(
            and(
              eq(agentJobs.organizationId, options.organizationId),
              eq(agentJobs.idempotencyKey, options.idempotencyKey!),
            ),
          )
          .limit(1),
    );

    const priorJob = existing[0];
    if (priorJob) {
      log.info({ jobId: priorJob.id }, 'idempotent replay: returning the original job');
      return {
        requestRef: priorJob.correlationId,
        jobId: priorJob.id,
        response: {
          requestId: priorJob.id,
          outcome: priorJob.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED',
          result: priorJob.output as TResult | undefined,
          error: priorJob.errorCode
            ? { code: priorJob.errorCode, detail: priorJob.errorDetail ?? undefined, retryable: false }
            : undefined,
          durationMs:
            priorJob.completedAt && priorJob.startedAt
              ? priorJob.completedAt.getTime() - priorJob.startedAt.getTime()
              : 0,
        },
      };
    }
  }

  // --- Record the attempt --------------------------------------------------
  const requestRef = newRequestId();
  const startedAt = new Date();

  const { requestRowId, jobId } = await withTenant(
    { organizationId: options.organizationId, userId: options.userId },
    async (tx) => {
      const [requestRow] = await tx
        .insert(agentRequests)
        .values({
          organizationId: options.organizationId,
          userId: options.userId,
          requestRef,
          correlationId: options.correlationId,
          agent,
          action: options.action,
          locale: options.locale,
          status: 'PROCESSING',
          payload: sanitizePayload(options.payload),
          startedAt,
        })
        .returning({ id: agentRequests.id });

      if (!requestRow) {
        throw new AppError('internal_error', {
          internalMessage: 'agent_requests insert returned no row',
        });
      }

      let createdJobId: string | undefined;
      if (isJobBacked) {
        const [jobRow] = await tx
          .insert(agentJobs)
          .values({
            organizationId: options.organizationId,
            agentRequestId: requestRow.id,
            userId: options.userId,
            agent,
            action: options.action,
            status: 'PROCESSING',
            correlationId: options.correlationId,
            idempotencyKey: options.idempotencyKey ?? null,
            input: sanitizePayload(options.payload),
            attempts: 1,
            startedAt,
          })
          .returning({ id: agentJobs.id });
        createdJobId = jobRow?.id;
      }

      return { requestRowId: requestRow.id, jobId: createdJobId };
    },
  );

  // --- Call the agent ------------------------------------------------------
  const agentRequest: AgentRequest<TPayload> = {
    requestId: requestRef,
    correlationId: options.correlationId,
    tenantId: options.organizationId,
    userId: options.userId,
    agent,
    action: options.action,
    locale: options.locale,
    payload: options.payload,
    callbackUrl: `${env().APP_URL}/api/v1/webhooks/n8n`,
    idempotencyKey: options.idempotencyKey,
    metadata: options.metadata,
  };

  let response: AgentResponse<TResult>;
  try {
    response = (await adapter.execute(agentRequest)) as AgentResponse<TResult>;
  } catch (error) {
    // An adapter that throws rather than returning a FAILED response still has
    // to leave the request row in a terminal state.
    const appError = toAppError(error);
    response = {
      requestId: requestRef,
      outcome: 'FAILED',
      error: {
        code: appError.code,
        detail: appError.internalMessage,
        retryable: false,
      },
      durationMs: Date.now() - startedAt.getTime(),
    };
  }

  // --- Complete the records ------------------------------------------------
  const completedAt = new Date();
  const succeeded = response.outcome === 'COMPLETED';

  await withTenant(
    { organizationId: options.organizationId, userId: options.userId },
    async (tx) => {
      await tx
        .update(agentRequests)
        .set({
          status: succeeded ? 'COMPLETED' : 'FAILED',
          result: succeeded ? (response.result as Record<string, unknown>) : null,
          errorCode: response.error?.code ?? null,
          errorDetail: response.error?.detail?.slice(0, 4000) ?? null,
          n8nExecutionId: response.n8nExecutionId ?? null,
          durationMs: response.durationMs,
          completedAt,
        })
        .where(eq(agentRequests.id, requestRowId));

      if (jobId) {
        await tx
          .update(agentJobs)
          .set({
            status: succeeded ? 'COMPLETED' : 'FAILED',
            progress: succeeded ? 100 : 0,
            output: succeeded ? (response.result as Record<string, unknown>) : null,
            errorCode: response.error?.code ?? null,
            errorDetail: response.error?.detail?.slice(0, 4000) ?? null,
            n8nExecutionId: response.n8nExecutionId ?? null,
            completedAt,
            updatedAt: completedAt,
          })
          .where(eq(agentJobs.id, jobId));
      }

      // Meter every attempt; success-only metrics are filtered upstream.
      const metrics = usageMetricsFor(options.action, response);
      await tx.insert(usageRecords).values(
        metrics.map((metric) => ({
          organizationId: options.organizationId,
          userId: options.userId,
          metric,
          quantity: 1,
          agent,
          referenceId: requestRowId,
          occurredAt: completedAt,
        })),
      );
    },
  );

  log.info(
    {
      requestRef,
      jobId,
      outcome: response.outcome,
      durationMs: response.durationMs,
      errorCode: response.error?.code,
    },
    'agent invocation finished',
  );

  return { requestRef, jobId, response };
}
