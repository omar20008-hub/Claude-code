import { z } from 'zod';
import { route, jsonResponse } from '@/server/api/handler';
import { listConversations, createConversation } from '@/server/services/knowledge-service';
import { locales } from '@/i18n/config';

const querySchema = z.object({
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const GET = route({ querySchema }, async ({ session, query, correlationId }) => {
  const result = await listConversations({
    organizationId: session.organizationId,
    userId: session.userId,
    search: query.search,
    limit: query.limit,
    offset: query.offset,
  });

  return jsonResponse(result, correlationId);
});

const createSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  locale: z.enum(locales).optional(),
});

export const POST = route({ bodySchema: createSchema }, async ({ session, body, correlationId }) => {
  const conversation = await createConversation({
    organizationId: session.organizationId,
    userId: session.userId,
    locale: body.locale ?? session.locale,
    title: body.title ?? '',
    correlationId,
  });

  // agentSessionId is deliberately not returned: it is a capability handle for
  // the agent's memory and the browser has no use for it (§26).
  return jsonResponse({ id: conversation.id }, correlationId, { status: 201 });
});
