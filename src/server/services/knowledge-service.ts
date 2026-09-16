import { and, desc, eq, isNull, sql, ilike, or } from 'drizzle-orm';
import { withTenant } from '@/server/tenancy/context';
import {
  conversations,
  messages,
  knowledgeSources,
  knowledgeSyncs,
} from '@/server/db/schema';
import { invokeAgent } from '@/server/agents/gateway';
import { secureToken } from '@/lib/ids';
import { AppError } from '@/lib/errors';
import { recordAudit } from './audit';
import { KNOWLEDGE_REINDEX_INTERVAL_HOURS } from '@/server/agents/adapters/knowledge';
import type { KnowledgeAskPayload, KnowledgeAskResult } from '@/server/agents/contracts';
import type { Locale } from '@/i18n/config';

/**
 * Knowledge Agent domain service (§16).
 *
 * Owns conversations, messages and the citation records the UI renders. The
 * agent call itself goes through the gateway; nothing here knows about n8n.
 */

/**
 * The chat trigger keys its 10-turn buffer memory on `sessionId`, so that value
 * is effectively a capability handle for a conversation's history. It is
 * generated with 24 bytes of entropy rather than reusing the conversation UUID,
 * so knowing a conversation id does not let anyone resume its agent memory.
 */
function newAgentSessionId(): string {
  return `aiw_${secureToken(24)}`;
}

export interface ConversationSummary {
  id: string;
  title: string;
  lastMessageAt: Date;
  messageCount: number;
  locale: Locale;
}

export async function listConversations(params: {
  organizationId: string;
  userId: string;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<{ conversations: ConversationSummary[]; total: number }> {
  const limit = Math.min(params.limit ?? 30, 100);
  const offset = Math.max(params.offset ?? 0, 0);

  return withTenant({ organizationId: params.organizationId }, async (tx) => {
    const filters = [
      eq(conversations.organizationId, params.organizationId),
      eq(conversations.agent, 'KNOWLEDGE_AGENT'),
      isNull(conversations.deletedAt),
    ];

    // Search spans titles and message bodies so a user can find a conversation
    // by something they remember asking, not only by its generated title.
    if (params.search && params.search.trim().length > 0) {
      const pattern = `%${params.search.trim()}%`;
      filters.push(
        or(
          ilike(conversations.title, pattern),
          sql`EXISTS (
            SELECT 1 FROM ${messages}
            WHERE ${messages.conversationId} = ${conversations.id}
              AND ${messages.content} ILIKE ${pattern}
          )`,
        )!,
      );
    }

    const where = and(...filters);

    const [rows, counted] = await Promise.all([
      tx
        .select({
          id: conversations.id,
          title: conversations.title,
          lastMessageAt: conversations.lastMessageAt,
          messageCount: conversations.messageCount,
          locale: conversations.locale,
        })
        .from(conversations)
        .where(where)
        .orderBy(desc(conversations.lastMessageAt))
        .limit(limit)
        .offset(offset),
      tx.select({ count: sql<number>`count(*)::int` }).from(conversations).where(where),
    ]);

    return {
      conversations: rows as ConversationSummary[],
      total: counted[0]?.count ?? 0,
    };
  });
}

export async function createConversation(params: {
  organizationId: string;
  userId: string;
  locale: Locale;
  title: string;
  correlationId: string;
}): Promise<{ id: string; agentSessionId: string }> {
  const agentSessionId = newAgentSessionId();

  const created = await withTenant(
    { organizationId: params.organizationId, userId: params.userId },
    async (tx) => {
      const [row] = await tx
        .insert(conversations)
        .values({
          organizationId: params.organizationId,
          userId: params.userId,
          agent: 'KNOWLEDGE_AGENT',
          title: params.title.slice(0, 200),
          agentSessionId,
          locale: params.locale,
        })
        .returning({ id: conversations.id });

      if (!row) {
        throw new AppError('internal_error', {
          internalMessage: 'conversation insert returned no row',
        });
      }
      return row;
    },
  );

  await recordAudit({
    organizationId: params.organizationId,
    userId: params.userId,
    action: 'conversation.created',
    resourceType: 'conversation',
    resourceId: created.id,
    status: 'SUCCESS',
    correlationId: params.correlationId,
  });

  return { id: created.id, agentSessionId };
}

export async function getConversation(params: {
  organizationId: string;
  conversationId: string;
}) {
  const rows = await withTenant({ organizationId: params.organizationId }, (tx) =>
    tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.id, params.conversationId),
          eq(conversations.organizationId, params.organizationId),
          isNull(conversations.deletedAt),
        ),
      )
      .limit(1),
  );

  const conversation = rows[0];
  if (!conversation) throw new AppError('not_found');
  return conversation;
}

export async function listMessages(params: {
  organizationId: string;
  conversationId: string;
  limit?: number;
}) {
  // Confirms the conversation belongs to this tenant before reading messages.
  await getConversation(params);

  return withTenant({ organizationId: params.organizationId }, (tx) =>
    tx
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, params.conversationId),
          eq(messages.organizationId, params.organizationId),
        ),
      )
      .orderBy(messages.createdAt)
      .limit(Math.min(params.limit ?? 200, 500)),
  );
}

export interface AskResult {
  conversationId: string;
  userMessageId: string;
  assistantMessageId?: string;
  result?: KnowledgeAskResult;
  error?: { code: string; retryable: boolean };
}

/**
 * Asks a question and records both turns.
 *
 * The user's message is committed before the agent is called. If the agent then
 * fails or times out, the question is still in the conversation and the UI can
 * offer a retry against it — losing what someone typed because a downstream
 * service was slow is not acceptable.
 */
export async function askQuestion(params: {
  organizationId: string;
  userId: string;
  conversationId: string;
  question: string;
  locale: Locale;
  correlationId: string;
}): Promise<AskResult> {
  const conversation = await getConversation({
    organizationId: params.organizationId,
    conversationId: params.conversationId,
  });

  const userMessageId = await withTenant(
    { organizationId: params.organizationId, userId: params.userId },
    async (tx) => {
      const [row] = await tx
        .insert(messages)
        .values({
          organizationId: params.organizationId,
          conversationId: params.conversationId,
          role: 'USER',
          content: params.question,
        })
        .returning({ id: messages.id });

      await tx
        .update(conversations)
        .set({
          lastMessageAt: new Date(),
          messageCount: sql`${conversations.messageCount} + 1`,
          // The first question becomes the conversation's title — far more
          // useful in a history list than "Conversation 4".
          title:
            conversation.messageCount === 0
              ? params.question.slice(0, 120)
              : conversation.title,
          updatedAt: new Date(),
        })
        .where(eq(conversations.id, params.conversationId));

      return row!.id;
    },
  );

  const { response } = await invokeAgent<KnowledgeAskPayload, KnowledgeAskResult>({
    organizationId: params.organizationId,
    userId: params.userId,
    action: 'knowledge.ask',
    locale: params.locale,
    correlationId: params.correlationId,
    payload: {
      question: params.question,
      sessionId: conversation.agentSessionId,
    },
    metadata: { conversationId: params.conversationId },
  });

  if (response.outcome !== 'COMPLETED' || !response.result) {
    await recordAudit({
      organizationId: params.organizationId,
      userId: params.userId,
      action: 'knowledge.query',
      resourceType: 'conversation',
      resourceId: params.conversationId,
      status: 'FAILURE',
      correlationId: params.correlationId,
      metadata: { errorCode: response.error?.code },
    });

    return {
      conversationId: params.conversationId,
      userMessageId,
      error: {
        code: response.error?.code ?? 'agent_failed',
        retryable: response.error?.retryable ?? true,
      },
    };
  }

  const result = response.result;

  const assistantMessageId = await withTenant(
    { organizationId: params.organizationId, userId: params.userId },
    async (tx) => {
      const [row] = await tx
        .insert(messages)
        .values({
          organizationId: params.organizationId,
          conversationId: params.conversationId,
          role: 'ASSISTANT',
          content: result.answer,
          citations: result.citations,
          sourceBasis: result.sourceBasis,
        })
        .returning({ id: messages.id });

      await tx
        .update(conversations)
        .set({
          lastMessageAt: new Date(),
          messageCount: sql`${conversations.messageCount} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(conversations.id, params.conversationId));

      return row!.id;
    },
  );

  await recordAudit({
    organizationId: params.organizationId,
    userId: params.userId,
    action: 'knowledge.query',
    resourceType: 'conversation',
    resourceId: params.conversationId,
    status: 'SUCCESS',
    correlationId: params.correlationId,
    metadata: {
      citationCount: result.citations.length,
      sourceBasis: result.sourceBasis,
      durationMs: response.durationMs,
    },
  });

  return {
    conversationId: params.conversationId,
    userMessageId,
    assistantMessageId,
    result,
  };
}

/** Records thumbs up/down on an assistant message. */
export async function recordFeedback(params: {
  organizationId: string;
  messageId: string;
  feedback: 1 | -1 | null;
}): Promise<void> {
  const updated = await withTenant({ organizationId: params.organizationId }, (tx) =>
    tx
      .update(messages)
      .set({ feedback: params.feedback })
      .where(
        and(
          eq(messages.id, params.messageId),
          eq(messages.organizationId, params.organizationId),
          eq(messages.role, 'ASSISTANT'),
        ),
      )
      .returning({ id: messages.id }),
  );

  if (updated.length === 0) throw new AppError('not_found');
}

export async function deleteConversation(params: {
  organizationId: string;
  userId: string;
  conversationId: string;
  correlationId: string;
}): Promise<void> {
  const deleted = await withTenant(
    { organizationId: params.organizationId, userId: params.userId },
    (tx) =>
      tx
        .update(conversations)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(conversations.id, params.conversationId),
            eq(conversations.organizationId, params.organizationId),
            isNull(conversations.deletedAt),
          ),
        )
        .returning({ id: conversations.id }),
  );

  if (deleted.length === 0) throw new AppError('not_found');

  await recordAudit({
    organizationId: params.organizationId,
    userId: params.userId,
    action: 'conversation.deleted',
    resourceType: 'conversation',
    resourceId: params.conversationId,
    status: 'SUCCESS',
    correlationId: params.correlationId,
  });
}

export interface KnowledgeSourceStatus {
  id: string;
  displayName: string;
  externalId: string;
  supportedFormats: string[];
  /** null when the workflow has never reported a count — shown as "unknown". */
  documentCount: number | null;
  lastSyncedAt: Date | null;
  lastSyncStatus: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | null;
  reindexIntervalHours: number;
  recentFailures: number;
}

/**
 * Knowledge source status for the dashboard and settings panels.
 *
 * `documentCount` stays null unless something real reported it. The n8n
 * workflow exposes no document count, so the UI says "not reported by the
 * workflow" rather than showing a made-up number (§52).
 */
export async function getKnowledgeSourceStatus(
  organizationId: string,
): Promise<KnowledgeSourceStatus | null> {
  return withTenant({ organizationId }, async (tx) => {
    const rows = await tx
      .select()
      .from(knowledgeSources)
      .where(eq(knowledgeSources.organizationId, organizationId))
      .limit(1);

    const source = rows[0];
    if (!source) return null;

    const failures = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(knowledgeSyncs)
      .where(
        and(
          eq(knowledgeSyncs.organizationId, organizationId),
          eq(knowledgeSyncs.knowledgeSourceId, source.id),
          eq(knowledgeSyncs.status, 'FAILED'),
          sql`${knowledgeSyncs.startedAt} > now() - interval '7 days'`,
        ),
      );

    return {
      id: source.id,
      displayName: source.displayName,
      externalId: source.externalId,
      supportedFormats: source.supportedFormats,
      documentCount: source.documentCount,
      lastSyncedAt: source.lastSyncedAt,
      lastSyncStatus: source.lastSyncStatus,
      reindexIntervalHours: KNOWLEDGE_REINDEX_INTERVAL_HOURS,
      recentFailures: failures[0]?.count ?? 0,
    };
  });
}
