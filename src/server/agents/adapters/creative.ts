import { env } from '@/server/config/env';
import { AppError, toAppError } from '@/lib/errors';
import { sendChatMessage, type N8nChatMessage } from '../n8n-client';
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentRequest,
  AgentResponse,
  CreativeAspectRatio,
  CreativeGeneratePayload,
  CreativeGenerateResult,
} from '../contracts';

/**
 * Creative Agent adapter.
 *
 * Target workflow: "استوديو المحتوى المرئي — Gemini + Veo + Google Drive"
 * (7GYulsPGi7WFpJzx)
 *
 * Discovered contract:
 *  - Chat trigger, `responseMode: responseNodes`, public webhook,
 *    `loadPreviousSession: notSupported`.
 *  - A "Content Director" agent turns the user's description into a structured
 *    brief: { content_type, title, image_prompt, video_prompt, aspect_ratio,
 *    duration_seconds, caption, reply }.
 *  - The workflow then streams several messages: a brief acknowledgement, then
 *    the image inline as a markdown `data:` URI, then an approval prompt.
 *
 * TWO HARD LIMITS, both verified in the workflow definition rather than assumed:
 *
 *  1. VIDEO IS DISABLED. The Content Director's system prompt forbids
 *     `content_type: "video"` outright, and the workflow's own sticky note
 *     records why: "نماذج Veo مدفوعة والحصة المجانية صفر على المفتاح الحالي"
 *     (Veo is paid and the free quota on the current key is zero). The Veo
 *     branch exists but is unreachable. A video request therefore comes back as
 *     a key-frame image, and this adapter reports that downgrade explicitly
 *     instead of passing a still off as a video (§52).
 *
 *  2. THE WORKFLOW BLOCKS ON A HUMAN APPROVAL. After showing the image it hits
 *     a `sendAndWait` node asking whether to save to Google Drive, and waits
 *     (up to 2 hours) for a reply on a separate approval webhook. The SaaS does
 *     not answer that prompt: it takes the inline image it already received and
 *     stores it in its own object storage, which is where the asset library
 *     reads from. The pending n8n execution times out harmlessly.
 */

/** Google Drive folder the workflow offers to save into. Informational only. */
export const CREATIVE_DRIVE_FOLDER_ID = '1Q-RQgsMxyCja_HYDU6h0ZauCs7ETF5PA';
export const CREATIVE_DRIVE_FOLDER_NAME = 'n8n - media';

/** Pixel dimensions the workflow requests per aspect ratio. */
export const CREATIVE_DIMENSIONS: Record<
  CreativeAspectRatio,
  { width: number; height: number }
> = {
  '16:9': { width: 1280, height: 720 },
  '9:16': { width: 768, height: 1280 },
};

/**
 * The workflow generates images through Pollinations' `flux` endpoint, despite
 * the node being named after Nano Banana. Recorded accurately so asset metadata
 * and the UI name the model that actually ran.
 */
export const CREATIVE_IMAGE_MODEL = 'pollinations/flux';

/** Matches a markdown image whose source is an inline data URI. */
const DATA_URI_IMAGE =
  /!\[[^\]]*\]\(\s*data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+?)\s*\)/i;

/** Bare data URI, for frames that carry the image without markdown wrapping. */
const BARE_DATA_URI = /data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/i;

/**
 * Pulls the generated image out of the streamed frames.
 *
 * The workflow embeds it as a base64 data URI inside a markdown image tag in
 * the "Show Image in Chat" message. Both the markdown and bare forms are
 * accepted so a formatting change upstream does not silently lose the asset.
 */
function extractInlineImage(
  messages: N8nChatMessage[],
): { base64: string; mimeType: string } | undefined {
  for (const message of messages) {
    const match = DATA_URI_IMAGE.exec(message.text) ?? BARE_DATA_URI.exec(message.text);
    if (match?.[1] && match[2]) {
      return {
        mimeType: match[1].toLowerCase(),
        // Streamed frames can wrap long base64 across lines.
        base64: match[2].replace(/\s+/g, ''),
      };
    }
  }
  return undefined;
}

/** Reads a `**Label:** value` or `الحقل: value` pair out of the ack message. */
function extractLabelled(text: string, labels: string[]): string | undefined {
  for (const label of labels) {
    const pattern = new RegExp(
      `\\*{0,2}${label}\\*{0,2}\\s*[:：]\\s*\\*{0,2}([^\\n*]+)`,
      'iu',
    );
    const match = pattern.exec(text);
    const value = match?.[1]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * Recovers the English prompt the Content Director wrote.
 *
 * The workflow prints it in a fenced code span after a "البرومبت المستخدم"
 * label. Worth capturing: it is what a user needs to reproduce or tweak a
 * generation, and it goes into the asset's metadata.
 */
function extractPromptUsed(text: string): string | undefined {
  const fenced = /`{1,3}\s*([^`]{10,})\s*`{1,3}/u.exec(text);
  if (fenced?.[1]) return fenced[1].trim();
  return extractLabelled(text, ['البرومبت المستخدم', 'prompt used', 'البرومبت']);
}

/** Strips markdown image tags so the reply text stays readable. */
function withoutImages(text: string): string {
  return text.replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim();
}

export class CreativeAgentAdapter
  implements AgentAdapter<CreativeGeneratePayload, CreativeGenerateResult>
{
  readonly agent = 'CREATIVE_AGENT' as const;
  readonly actions = ['creative.generate'] as const;

  isConfigured(): boolean {
    return Boolean(env().N8N_BASE_URL && env().N8N_CREATIVE_WEBHOOK_ID);
  }

  capabilities(): AgentCapabilities {
    return {
      agent: this.agent,
      configured: this.isConfigured(),
      supports: {
        streaming: true,
        localeMetadata: false,
        callbacks: false,
        executionIds: false,
        fileUploads: false,
      },
      unavailable: [
        {
          capability: 'video_generation',
          reasonKey: 'creative.video.unavailableBody',
        },
        {
          capability: 'custom_dimensions',
          reasonKey: 'creative.form.aspectRatioHint',
        },
      ],
    };
  }

  /** True when the connected workflow can actually produce video. */
  supportsVideo(): boolean {
    // Hard-coded false, matching the workflow's own agent instructions. This is
    // a single, honest source of truth: flipping it requires re-enabling the
    // Veo branch in n8n, and the UI reads this rather than guessing.
    return false;
  }

  /**
   * Builds the chat message.
   *
   * The Content Director reads free text, so the request is phrased the way a
   * person would, with the aspect ratio stated explicitly because the brief
   * schema has an `aspect_ratio` field the agent fills from context.
   */
  private buildChatInput(payload: CreativeGeneratePayload): string {
    const orientation =
      payload.aspectRatio === '9:16'
        ? 'عمودي 9:16 (ريلز/ستوري)'
        : 'أفقي 16:9';

    return [payload.prompt, `الأبعاد المطلوبة: ${orientation}.`].join('\n\n');
  }

  async execute(
    request: AgentRequest<CreativeGeneratePayload>,
  ): Promise<AgentResponse<CreativeGenerateResult>> {
    const startedAt = Date.now();

    if (!this.isConfigured()) {
      throw new AppError('integration_not_configured', {
        internalMessage: 'Creative adapter is missing N8N_BASE_URL or webhook id',
      });
    }

    const webhookId = env().N8N_CREATIVE_WEBHOOK_ID;
    if (!webhookId) {
      throw new AppError('integration_not_configured', {
        internalMessage: 'N8N_CREATIVE_WEBHOOK_ID is unset',
      });
    }

    try {
      const response = await sendChatMessage({
        webhookId,
        sessionId: request.payload.sessionId,
        chatInput: this.buildChatInput(request.payload),
        correlationId: request.correlationId,
      });

      const media = extractInlineImage(response.messages);
      const proseFrames = response.messages
        .map((m) => withoutImages(m.text))
        .filter((t) => t.length > 0);
      const prose = proseFrames.join('\n\n');

      // No image came back. The workflow may legitimately have replied with a
      // clarifying question (content_type: "text") rather than generating —
      // that is a real outcome, not a silent failure, so it is reported as a
      // failure with the agent's own words preserved for the user.
      if (!media) {
        return {
          requestId: request.requestId,
          outcome: 'FAILED',
          error: {
            code: 'agent_failed',
            detail:
              prose.length > 0
                ? `Creative workflow returned no media. Agent said: ${prose.slice(0, 500)}`
                : 'Creative workflow returned neither media nor text',
            retryable: true,
          },
          durationMs: Date.now() - startedAt,
          diagnostics: { agentReply: prose.slice(0, 2000) },
        };
      }

      const title =
        extractLabelled(prose, ['العنوان', 'title']) ??
        request.payload.prompt.slice(0, 80);

      const result: CreativeGenerateResult = {
        // Always an image: the video branch is unreachable in this workflow.
        producedKind: 'IMAGE',
        title,
        promptUsed: extractPromptUsed(prose),
        caption: extractLabelled(prose, ['النص التسويقي', 'caption']),
        aspectRatio: request.payload.aspectRatio,
        media,
        // Tells the UI to say plainly that a key frame was produced instead of
        // the requested video.
        downgradedFrom: request.payload.mediaType === 'VIDEO' ? 'VIDEO' : undefined,
        agentReply: prose.length > 0 ? prose : undefined,
      };

      return {
        requestId: request.requestId,
        outcome: 'COMPLETED',
        result,
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
          retryable:
            appError.code === 'agent_timeout' || appError.code === 'agent_unavailable',
        },
        durationMs: Date.now() - startedAt,
      };
    }
  }
}

export const creativeAgentAdapter = new CreativeAgentAdapter();
