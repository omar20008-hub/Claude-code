import { z } from 'zod';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import { route, jsonResponse } from '@/server/api/handler';
import { withTenant } from '@/server/tenancy/context';
import { agentJobs } from '@/server/db/schema';

const querySchema = z.object({
  status: z.enum(['QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED']).optional(),
  agent: z.enum(['KNOWLEDGE_AGENT', 'CREATIVE_AGENT', 'ADVERTISING_AGENT']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * Job list (§27).
 *
 * Every field §27 requires is present: job id, request id, tenant (implicit in
 * the scope), user, agent, action, status, timestamps, error information,
 * correlation id and the n8n execution id.
 *
 * `n8nExecutionId` is usually null, and honestly so: the chat-trigger webhooks
 * the three workflows use do not return one. It is populated only when a
 * workflow reports it through the callback endpoint.
 */
export const GET = route({ querySchema }, async ({ session, query, correlationId }) => {
  const filters: SQL[] = [eq(agentJobs.organizationId, session.organizationId)];
  if (query.status) filters.push(eq(agentJobs.status, query.status));
  if (query.agent) filters.push(eq(agentJobs.agent, query.agent));

  const rows = await withTenant({ organizationId: session.organizationId }, (tx) =>
    tx
      .select({
        id: agentJobs.id,
        agentRequestId: agentJobs.agentRequestId,
        userId: agentJobs.userId,
        agent: agentJobs.agent,
        action: agentJobs.action,
        status: agentJobs.status,
        progress: agentJobs.progress,
        correlationId: agentJobs.correlationId,
        n8nExecutionId: agentJobs.n8nExecutionId,
        errorCode: agentJobs.errorCode,
        attempts: agentJobs.attempts,
        createdAt: agentJobs.createdAt,
        startedAt: agentJobs.startedAt,
        completedAt: agentJobs.completedAt,
        // errorDetail is withheld: it is engineer-facing and may quote an
        // upstream message. The UI localizes `errorCode` instead (§38).
      })
      .from(agentJobs)
      .where(and(...filters))
      .orderBy(desc(agentJobs.createdAt))
      .limit(Math.min(query.limit ?? 25, 100)),
  );

  return jsonResponse({ jobs: rows }, correlationId);
});
