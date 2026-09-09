import { env } from '@/server/config/env';
import { AppError, toAppError } from '@/lib/errors';
import { localeTag } from '@/i18n/config';
import { sendChatMessage } from '../n8n-client';
import { parseKnowledgeAnswer } from '../citations';
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentRequest,
  AgentResponse,
  KnowledgeAskPayload,
  KnowledgeAskResult,
} from '../contracts';

/**
 * Knowledge Agent adapter.
 *
 * Target workflow: "Agentic RAG — Google Drive + Web Fallback" (pOwwQdXNflGHVaV8)
 *
 * Discovered contract:
 *  - Chat trigger, `responseMode: streaming`, public webhook.
 *  - Input:  { action: 'sendMessage', sessionId, chatInput }
 *  - Output: token-level NDJSON frames that concatenate into one markdown answer.
 *  - Memory: `memoryBufferWindow` with contextWindowLength 10, keyed on
 *    sessionId. Conversation continuity is entirely a function of reusing it.
 *  - Sources: written inline as `[ملف: …]` / `[ويب: … — https://…]`. Parsed
 *    back out by ../citations.ts.
 *  - No confidence score, no execution id, no callback.
 *  - Knowledge origin is a single Google Drive folder configured inside n8n,
 *    reindexed on a 6-hour schedule. It is not per-tenant.
 */

/** The 6-hourly `Refresh Index Every 6h` schedule trigger in the workflow. */
export const KNOWLEDGE_REINDEX_INTERVAL_HOURS = 6;

/** Google Drive folder the workflow indexes, for display in Settings. */
export const KNOWLEDGE_DRIVE_FOLDER_ID = '1REHc656Hc9jGmB3-y_40cvnVeVTSvyVt';
export const KNOWLEDGE_DRIVE_FOLDER_NAME = 'n8n agent';

export const KNOWLEDGE_SUPPORTED_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.google-apps.document',
  'text/plain',
] as const;

/**
 * The workflow has no `locale` parameter. Its system prompt says "Reply in the
 * same language the user writes in", so language is conveyed by the question
 * itself — which works, because the user writes in their own language.
 *
 * A short steer is prepended only when the UI locale and the apparent language
 * of the question disagree, so an Arabic-UI user who types an English question
 * still gets an Arabic answer if that is what their interface implies. The
 * steer is deliberately minimal: it must not become a second system prompt
 * competing with the workflow's own.
 */
function buildChatInput(question: string, localeTagValue: string): string {
  const wantsArabic = localeTagValue.startsWith('ar');
  const questionLooksArabic = /[؀-ۿ]/.test(question);

  if (wantsArabic === questionLooksArabic) return question;

  const steer = wantsArabic
    ? 'أجب بالعربية.'
    : 'Answer in English.';
  return `${steer}\n\n${question}`;
}

export class KnowledgeAgentAdapter
  implements AgentAdapter<KnowledgeAskPayload, KnowledgeAskResult>
{
  readonly agent = 'KNOWLEDGE_AGENT' as const;
  readonly actions = ['knowledge.ask'] as const;

  isConfigured(): boolean {
    return Boolean(env().N8N_BASE_URL && env().N8N_KNOWLEDGE_WEBHOOK_ID);
  }

  capabilities(): AgentCapabilities {
    return {
      agent: this.agent,
      configured: this.isConfigured(),
      supports: {
        streaming: true,
        // No `locale` field exists on the trigger; language is inferred from
        // the question text by the agent's own system prompt.
        localeMetadata: false,
        callbacks: false,
        executionIds: false,
        fileUploads: false,
      },
      unavailable: [
        {
          capability: 'confidence_score',
          reasonKey: 'knowledge.sources.parsedNotice',
        },
        {
          capability: 'structured_sources',
          reasonKey: 'knowledge.sources.parsedNotice',
        },
        {
          capability: 'per_tenant_drive',
          reasonKey: 'settings.integrations.googleDrive.credentialNotice',
        },
        {
          capability: 'document_count',
          reasonKey: 'knowledge.sourcePanel.documentsUnknown',
        },
      ],
    };
  }

  async execute(
    request: AgentRequest<KnowledgeAskPayload>,
  ): Promise<AgentResponse<KnowledgeAskResult>> {
    const startedAt = Date.now();

    if (!this.isConfigured()) {
      throw new AppError('integration_not_configured', {
        internalMessage: 'Knowledge adapter is missing N8N_BASE_URL or webhook id',
      });
    }

    const webhookId = env().N8N_KNOWLEDGE_WEBHOOK_ID;
    if (!webhookId) {
      throw new AppError('integration_not_configured', {
        internalMessage: 'N8N_KNOWLEDGE_WEBHOOK_ID is unset',
      });
    }

    try {
      const response = await sendChatMessage({
        webhookId,
        sessionId: request.payload.sessionId,
        chatInput: buildChatInput(request.payload.question, localeTag(request.locale)),
        correlationId: request.correlationId,
      });

      const answer = response.text.trim();

      // An empty body means the workflow ran but produced nothing. That is a
      // failure to report, not an empty answer bubble to render.
      if (answer.length === 0) {
        return {
          requestId: request.requestId,
          outcome: 'FAILED',
          error: {
            code: 'agent_failed',
            detail: 'Knowledge workflow returned an empty response body',
            retryable: true,
          },
          durationMs: Date.now() - startedAt,
          diagnostics: { frameCount: response.messages.length, status: response.status },
        };
      }

      return {
        requestId: request.requestId,
        outcome: 'COMPLETED',
        result: parseKnowledgeAnswer(answer),
        n8nExecutionId: response.executionId,
        durationMs: Date.now() - startedAt,
        diagnostics: { frameCount: response.messages.length },
      };
    } catch (error) {
      const appError = toAppError(error);
      return {
        requestId: request.requestId,
        outcome: 'FAILED',
        error: {
          code: appError.code,
          detail: appError.internalMessage,
          retryable: appError.code === 'agent_timeout' || appError.code === 'agent_unavailable',
        },
        durationMs: Date.now() - startedAt,
      };
    }
  }
}

export const knowledgeAgentAdapter = new KnowledgeAgentAdapter();
