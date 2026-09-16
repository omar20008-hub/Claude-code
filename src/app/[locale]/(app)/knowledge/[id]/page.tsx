import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { requireSession } from '@/server/auth/session';
import {
  listConversations,
  getConversation,
  listMessages,
  getKnowledgeSourceStatus,
} from '@/server/services/knowledge-service';
import { capabilitiesFor } from '@/server/agents/gateway';
import { KnowledgeWorkspace } from '@/components/knowledge/workspace';
import { isAppError } from '@/lib/errors';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations('knowledge');
  return { title: t('title') };
}

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireSession();

  try {
    const [conversations, conversation, messages, source] = await Promise.all([
      listConversations({
        organizationId: session.organizationId,
        userId: session.userId,
        limit: 40,
      }),
      // Tenant-scoped: a conversation belonging to another organization is
      // simply not found, with no way to tell it apart from one that never
      // existed.
      getConversation({ organizationId: session.organizationId, conversationId: id }),
      listMessages({ organizationId: session.organizationId, conversationId: id }),
      getKnowledgeSourceStatus(session.organizationId),
    ]);

    const capability = capabilitiesFor('KNOWLEDGE_AGENT');

    return (
      <KnowledgeWorkspace
        initialConversations={conversations.conversations.map((entry) => ({
          id: entry.id,
          title: entry.title,
          lastMessageAt: entry.lastMessageAt.toISOString(),
          messageCount: entry.messageCount,
        }))}
        activeConversationId={conversation.id}
        initialMessages={messages.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          citations: message.citations,
          sourceBasis: message.sourceBasis,
          feedback: message.feedback,
          createdAt: message.createdAt.toISOString(),
        }))}
        source={
          source
            ? {
                displayName: source.displayName,
                documentCount: source.documentCount,
                lastSyncedAt: source.lastSyncedAt?.toISOString() ?? null,
                lastSyncStatus: source.lastSyncStatus,
                reindexIntervalHours: source.reindexIntervalHours,
                recentFailures: source.recentFailures,
              }
            : null
        }
        configured={capability.configured}
      />
    );
  } catch (error) {
    if (isAppError(error) && error.code === 'not_found') notFound();
    throw error;
  }
}
