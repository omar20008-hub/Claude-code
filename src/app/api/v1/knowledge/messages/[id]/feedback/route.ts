import { z } from 'zod';
import { route, jsonResponse } from '@/server/api/handler';
import { recordFeedback } from '@/server/services/knowledge-service';
import { AppError } from '@/lib/errors';

const bodySchema = z.object({
  /** 1 = helpful, -1 = not helpful, null clears a previous rating. */
  feedback: z.union([z.literal(1), z.literal(-1), z.null()]),
});

export const PATCH = route({ bodySchema }, async ({ session, body, params, correlationId }) => {
  const id = params.id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new AppError('not_found');

  // Tenant-scoped inside the service: a message id from another organization
  // resolves to not_found rather than being silently rated.
  await recordFeedback({
    organizationId: session.organizationId,
    messageId: id,
    feedback: body.feedback,
  });

  return jsonResponse({ ok: true }, correlationId);
});
