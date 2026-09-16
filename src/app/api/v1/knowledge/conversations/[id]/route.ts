import { route, jsonResponse } from '@/server/api/handler';
import {
  getConversation,
  listMessages,
  deleteConversation,
} from '@/server/services/knowledge-service';
import { AppError } from '@/lib/errors';

function conversationId(params: Record<string, string>): string {
  const id = params.id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new AppError('not_found');
  return id;
}

export const GET = route({}, async ({ session, params, correlationId }) => {
  const id = conversationId(params);

  const [conversation, messages] = await Promise.all([
    getConversation({ organizationId: session.organizationId, conversationId: id }),
    listMessages({ organizationId: session.organizationId, conversationId: id }),
  ]);

  return jsonResponse(
    {
      conversation: {
        id: conversation.id,
        title: conversation.title,
        locale: conversation.locale,
        messageCount: conversation.messageCount,
        lastMessageAt: conversation.lastMessageAt,
        createdAt: conversation.createdAt,
        // agentSessionId is withheld on purpose.
      },
      messages: messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        citations: message.citations,
        sourceBasis: message.sourceBasis,
        feedback: message.feedback,
        createdAt: message.createdAt,
      })),
    },
    correlationId,
  );
});

export const DELETE = route({}, async ({ session, params, correlationId }) => {
  await deleteConversation({
    organizationId: session.organizationId,
    userId: session.userId,
    conversationId: conversationId(params),
    correlationId,
  });

  return jsonResponse({ ok: true }, correlationId);
});
