import { getTranslations } from 'next-intl/server';
import { requireSession } from '@/server/auth/session';
import { listConversations, getKnowledgeSourceStatus } from '@/server/services/knowledge-service';
import { capabilitiesFor } from '@/server/agents/gateway';
import { KnowledgeWorkspace } from '@/components/knowledge/workspace';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations('knowledge');
  return { title: t('title') };
}

export default async function KnowledgePage() {
  const session = await requireSession();

  const [conversations, source] = await Promise.all([
    listConversations({
      organizationId: session.organizationId,
      userId: session.userId,
      limit: 40,
    }),
    getKnowledgeSourceStatus(session.organizationId),
  ]);

  const capability = capabilitiesFor('KNOWLEDGE_AGENT');

  return (
    <KnowledgeWorkspace
      initialConversations={conversations.conversations.map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        lastMessageAt: conversation.lastMessageAt.toISOString(),
        messageCount: conversation.messageCount,
      }))}
      activeConversationId={null}
      initialMessages={[]}
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
}
