import { z } from 'zod';
import { route, jsonResponse } from '@/server/api/handler';
import { queryAuditLogs, type AuditAction } from '@/server/services/audit';

const querySchema = z.object({
  action: z.string().max(80).optional(),
  userId: z.string().uuid().optional(),
  resourceType: z.string().max(60).optional(),
  status: z.enum(['SUCCESS', 'FAILURE']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/**
 * Audit trail (§35).
 *
 * Read-only by construction: there is no POST, PATCH or DELETE here, the
 * application database role has no UPDATE/DELETE privilege on the table, and a
 * trigger rejects both regardless.
 */
export const GET = route({ querySchema }, async ({ session, query, correlationId }) => {
  const result = await queryAuditLogs({
    organizationId: session.organizationId,
    action: query.action as AuditAction | undefined,
    userId: query.userId,
    resourceType: query.resourceType,
    status: query.status,
    from: query.from,
    to: query.to,
    limit: query.limit,
    offset: query.offset,
  });

  return jsonResponse(
    {
      entries: result.entries.map((entry) => ({
        id: entry.id,
        // An i18n key; the client renders it in the reader's language.
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        status: entry.status,
        actorEmail: entry.actorEmail,
        userId: entry.userId,
        correlationId: entry.correlationId,
        metadata: entry.metadata,
        createdAt: entry.createdAt,
        // ipAddress and userAgent are withheld: they are retained for incident
        // response, not for routine display.
      })),
      total: result.total,
    },
    correlationId,
  );
});
