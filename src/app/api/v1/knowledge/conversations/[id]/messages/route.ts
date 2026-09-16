import { z } from 'zod';
import { route, jsonResponse } from '@/server/api/handler';
import { askQuestion } from '@/server/services/knowledge-service';
import { POLICIES } from '@/server/security/rate-limit';
import { AppError } from '@/lib/errors';

const bodySchema = z.object({
  question: z.string().trim().min(1).max(4000),
});

export const POST = route(
  { bodySchema, rateLimit: POLICIES.agentInvocation },
  async ({ session, body, params, correlationId }) => {
    const id = params.id;
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new AppError('not_found');

    const result = await askQuestion({
      organizationId: session.organizationId,
      userId: session.userId,
      conversationId: id,
      question: body.question,
      locale: session.locale,
      correlationId,
    });

    // A failed agent call is not an HTTP error: the user's question was saved
    // and the UI needs to render it alongside a retryable error state. Sending
    // a 5xx here would discard the turn the user just typed.
    return jsonResponse(result, correlationId, { status: result.error ? 200 : 201 });
  },
);
