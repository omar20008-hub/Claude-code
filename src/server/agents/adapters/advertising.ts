import { env } from '@/server/config/env';
import { AppError, toAppError } from '@/lib/errors';
import { sendChatMessage, type N8nChatMessage } from '../n8n-client';
import type {
  AdvertisingSubmitPayload,
  AdvertisingSubmitResult,
  AgentAdapter,
  AgentCapabilities,
  AgentRequest,
  AgentResponse,
} from '../contracts';

/**
 * Advertising Agent adapter.
 *
 * Target workflow: "محادثة إنشاء إعلان على Meta Ads" (Pm3x6FweL5opKlj0)
 *
 * Discovered contract:
 *  - Chat trigger, `responseMode: responseNodes`, `allowFileUploads: true`,
 *    accepting image/jpeg, image/png, image/webp, video/mp4, video/quicktime.
 *    The workflow's own subtitle states attachments are only read on the FIRST
 *    message, so the creative must ride along with the initial submission.
 *  - An intake agent extracts a structured `adData` object and refuses to
 *    proceed while duration, audience or budget are missing. It gives up after
 *    six rounds.
 *  - It validates the creative against Meta's specs, then creates a campaign,
 *    an ad set and an ad via the Graph API.
 *
 * THE CRITICAL FACT: every object is created with `status: 'PAUSED'`, and the
 * workflow's success message tells the user to activate it manually in Ads
 * Manager. There is no activation step anywhere in the workflow. "Launch" in
 * this product therefore means "create the objects on Meta, paused" — the UI
 * says so in both languages, and the campaign lands in PAUSED rather than
 * ACTIVE. Reporting it as live would be a fabrication (§52).
 *
 * ALSO ABSENT: any Insights/reporting node. Impressions, clicks, CTR, CPC,
 * conversions and ROAS cannot be read through this workflow, so the analytics
 * layer reports them as unavailable rather than inventing numbers (§36).
 *
 * Credentials (`facebookGraphApi`), the ad account and the page all live inside
 * n8n. None of them is ever sent to the browser (§3, §23).
 */

/** Configuration baked into the workflow's "Ad Config" node. */
export const META_CONFIG = {
  adAccountId: '125720069264571',
  pageId: '1322234657642558',
  apiVersion: 'v26.0',
  currency: 'SAR',
  objective: 'OUTCOME_TRAFFIC',
  defaultCountry: 'SA',
  /** Ad set scheduling is emitted with a fixed +03:00 offset. */
  scheduleOffset: '+0300',
  timezone: 'Asia/Riyadh',
} as const;

export const META_ACCEPTED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/quicktime',
] as const;

/** Fixed optimization settings from the "Build Ad Set Payload" node. */
export const META_ADSET_DEFAULTS = {
  billingEvent: 'IMPRESSIONS',
  optimizationGoal: 'LINK_CLICKS',
  bidStrategy: 'LOWEST_COST_WITHOUT_CAP',
} as const;

/** Meta object ids are long decimal strings. */
const ID_PATTERN = '(\\d{6,})';

function matchId(text: string, labels: string[]): string | undefined {
  for (const label of labels) {
    const pattern = new RegExp(`${label}\\s*[:：]?\\s*\`?${ID_PATTERN}`, 'iu');
    const match = pattern.exec(text);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

/**
 * Reads Meta ids out of the workflow's success message, which prints them as:
 *
 *   Campaign: 120xxxxxxxxxx
 *   Ad Set:   120xxxxxxxxxx
 *   Ad:       120xxxxxxxxxx
 *
 * A JSON frame is preferred when one is present; the text form is the fallback,
 * because that is what the current workflow actually emits.
 */
function extractMetaIds(messages: N8nChatMessage[]): {
  campaignId?: string;
  adSetId?: string;
  adId?: string;
  audienceLabel?: string;
} {
  // Prefer structured data if a frame carries it.
  for (const message of messages) {
    const raw = message.raw as Record<string, unknown> | undefined;
    if (raw && typeof raw === 'object') {
      const campaignId = raw.campaignId ?? raw.campaign_id;
      const adSetId = raw.adSetId ?? raw.adset_id;
      if (typeof campaignId === 'string' && typeof adSetId === 'string') {
        return {
          campaignId,
          adSetId,
          adId: typeof raw.adId === 'string' ? raw.adId : undefined,
        };
      }
    }
  }

  const text = messages.map((m) => m.text).join('\n');

  // "Ad Set" must be tried before "Ad", or the looser pattern captures it.
  const adSetId = matchId(text, ['Ad\\s*Set', 'AdSet', 'المجموعة الإعلانية']);
  const campaignId = matchId(text, ['Campaign', 'الحملة']);
  const adId = matchId(text, ['(?<!Set\\s)\\bAd\\b', 'الإعلان']);

  const audienceMatch = /(?:الجمهور|Audience)\s*[:：]\s*([^\n]+)/iu.exec(text);

  return {
    campaignId,
    adSetId,
    // Guard against the "Ad" pattern having matched the ad set line anyway.
    adId: adId && adId !== adSetId ? adId : undefined,
    audienceLabel: audienceMatch?.[1]?.trim(),
  };
}

/** Detects the workflow's rejection / "missing information" replies. */
function detectRejection(text: string): { reason: string; missingFields: string[] } | null {
  const rejectionSignals =
    /(?:أحتاج|ناقص|غير صالح|لا يمكن|تعذّر|مرفوض|missing|invalid|cannot|rejected|required)/iu;

  if (!rejectionSignals.test(text)) return null;

  const fields: string[] = [];
  const fieldMap: Array<[RegExp, string]> = [
    [/ميزانية|budget/iu, 'lifetimeBudget'],
    [/المدة|تاريخ|duration|date|schedule/iu, 'schedule'],
    [/جمهور|audience/iu, 'audience'],
    [/رابط|url|destination/iu, 'destinationUrl'],
    [/نص|عنوان|headline|primary text/iu, 'copy'],
    [/صورة|فيديو|مادة|creative|image|video/iu, 'creative'],
  ];

  for (const [pattern, field] of fieldMap) {
    if (pattern.test(text)) fields.push(field);
  }

  return { reason: text.slice(0, 1000), missingFields: fields };
}

export class AdvertisingAgentAdapter
  implements AgentAdapter<AdvertisingSubmitPayload, AdvertisingSubmitResult>
{
  readonly agent = 'ADVERTISING_AGENT' as const;
  readonly actions = ['advertising.submit_campaign'] as const;

  isConfigured(): boolean {
    return Boolean(env().N8N_BASE_URL && env().N8N_ADVERTISING_WEBHOOK_ID);
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
        fileUploads: true,
      },
      unavailable: [
        {
          capability: 'campaign_activation',
          reasonKey: 'advertising.pausedNotice.body',
        },
        {
          capability: 'performance_metrics',
          reasonKey: 'campaigns.performance.unavailableBody',
        },
        {
          capability: 'multiple_ad_accounts',
          reasonKey: 'settings.integrations.meta.multiAccountNotice',
        },
        {
          capability: 'custom_objective',
          reasonKey: 'advertising.wizard.objective.fixedNotice',
        },
        {
          capability: 'reach_estimate',
          reasonKey: 'advertising.wizard.audience.estimatedReachUnavailable',
        },
      ],
    };
  }

  /**
   * Renders the full brief as one chat message.
   *
   * The intake agent parses free text into its `adData` schema, so every field
   * is labelled with the exact vocabulary the workflow's own schema example
   * uses. Sending everything at once means the agent's `complete` flag is true
   * on the first pass and it proceeds straight to creation rather than
   * interrogating the SaaS across six rounds it cannot answer interactively.
   */
  private buildChatInput(payload: AdvertisingSubmitPayload): string {
    const lines: string[] = [
      'تفاصيل الإعلان كاملة، ابدأ الإنشاء مباشرة:',
      '',
      `اسم الحملة: ${payload.campaignName}`,
      `اسم الإعلان: ${payload.adName}`,
      `النص الأساسي: ${payload.primaryText}`,
      `العنوان: ${payload.headline}`,
    ];

    if (payload.description) lines.push(`الوصف: ${payload.description}`);

    lines.push(
      `رابط الوجهة: ${payload.destinationUrl}`,
      `زر الإجراء: ${payload.callToAction}`,
      `موضع الظهور: ${payload.placement}`,
      `تاريخ البداية: ${payload.startDate}`,
      `تاريخ النهاية: ${payload.endDate}`,
      `الميزانية الإجمالية: ${payload.lifetimeBudget} ${META_CONFIG.currency}`,
    );

    if (payload.savedAudienceId) {
      lines.push(
        `الجمهور المحفوظ: ${payload.savedAudienceName ?? ''} (${payload.savedAudienceId})`.trim(),
      );
    }
    if (payload.audienceNotes) lines.push(`ملاحظات الجمهور: ${payload.audienceNotes}`);
    if (payload.ageMin !== undefined) lines.push(`أصغر عمر: ${payload.ageMin}`);
    if (payload.ageMax !== undefined) lines.push(`أكبر عمر: ${payload.ageMax}`);

    lines.push(
      `الجنس: ${payload.genders}`,
      `الدول: ${payload.countries.join(', ')}`,
    );
    if (payload.cities.length > 0) lines.push(`المدن: ${payload.cities.join(', ')}`);

    return lines.join('\n');
  }

  async execute(
    request: AgentRequest<AdvertisingSubmitPayload>,
  ): Promise<AgentResponse<AdvertisingSubmitResult>> {
    const startedAt = Date.now();

    if (!this.isConfigured()) {
      throw new AppError('integration_not_configured', {
        internalMessage: 'Advertising adapter is missing N8N_BASE_URL or webhook id',
      });
    }

    const webhookId = env().N8N_ADVERTISING_WEBHOOK_ID;
    if (!webhookId) {
      throw new AppError('integration_not_configured', {
        internalMessage: 'N8N_ADVERTISING_WEBHOOK_ID is unset',
      });
    }

    const { creative } = request.payload;
    if (!META_ACCEPTED_MIME_TYPES.includes(creative.mimeType as never)) {
      throw new AppError('unsupported_media_type', {
        internalMessage: `Meta workflow rejects ${creative.mimeType}`,
      });
    }

    try {
      const response = await sendChatMessage({
        webhookId,
        sessionId: request.payload.sessionId,
        chatInput: this.buildChatInput(request.payload),
        // The creative rides on the first message; the workflow reads no
        // attachment after that.
        files: [
          {
            name: creative.fileName,
            type: creative.mimeType,
            data: creative.base64,
          },
        ],
        correlationId: request.correlationId,
      });

      const ids = extractMetaIds(response.messages);
      const prose = response.messages.map((m) => m.text.trim()).filter(Boolean).join('\n\n');

      // Success is defined by Meta actually returning object ids. Anything else
      // is a failure, however cheerfully the agent phrased it.
      if (!ids.campaignId || !ids.adSetId) {
        const rejection = detectRejection(prose);

        return {
          requestId: request.requestId,
          outcome: 'FAILED',
          error: {
            code: 'agent_failed',
            detail: rejection
              ? `Advertising agent rejected the submission: ${rejection.reason.slice(0, 500)}`
              : `Advertising workflow returned no Meta campaign id. Reply: ${prose.slice(0, 500)}`,
            // A rejection is the agent's considered judgement; retrying the
            // identical payload would only reproduce it.
            retryable: !rejection,
          },
          durationMs: Date.now() - startedAt,
          diagnostics: { agentReply: prose.slice(0, 4000) },
        };
      }

      return {
        requestId: request.requestId,
        outcome: 'COMPLETED',
        result: {
          metaCampaignId: ids.campaignId,
          metaAdSetId: ids.adSetId,
          metaAdId: ids.adId,
          // Not read from the reply: guaranteed by the workflow, which hard-codes
          // status PAUSED on all three create calls.
          objectStatus: 'PAUSED',
          audienceLabel: ids.audienceLabel,
          agentReply: prose || undefined,
        },
        n8nExecutionId: response.executionId,
        durationMs: Date.now() - startedAt,
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

export const advertisingAgentAdapter = new AdvertisingAgentAdapter();
