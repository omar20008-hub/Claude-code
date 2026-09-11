import { z } from 'zod';
import type { Locale } from '@/i18n/config';

/**
 * The internal agent contract (§25, §26).
 *
 * Everything above this file — routes, services, UI — speaks only in these
 * types. Nothing outside src/server/agents/ knows that n8n exists, that the
 * transport is a chat webhook, or that the Knowledge agent returns citations as
 * prose. Replacing n8n with LangGraph, the Claude Agent SDK or bespoke
 * infrastructure means writing new adapters, not touching the SaaS.
 */

export type AgentName = 'KNOWLEDGE_AGENT' | 'CREATIVE_AGENT' | 'ADVERTISING_AGENT';

export type AgentAction =
  | 'knowledge.ask'
  | 'creative.generate'
  | 'advertising.submit_campaign';

/**
 * A single agent invocation.
 *
 * `tenantId` and `userId` are present so an adapter can scope or attribute a
 * call, but §26 forbids leaking them to the client: they are never echoed into
 * a response body, and the adapters below do not forward them to n8n either,
 * because none of the three workflows accepts or uses them.
 */
export interface AgentRequest<TPayload = unknown> {
  requestId: string;
  correlationId: string;
  tenantId: string;
  userId: string;
  agent: AgentName;
  action: AgentAction;
  locale: Locale;
  payload: TPayload;
  /**
   * Absolute URL n8n should POST progress and completion to. Supplied on every
   * request even though none of the current workflows call it — see
   * docs/n8n-integration.md, "callback readiness".
   */
  callbackUrl?: string;
  /** Caller-supplied idempotency key for operations that must not double-run. */
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export type AgentOutcome = 'COMPLETED' | 'FAILED';

export interface AgentResponse<TResult = unknown> {
  requestId: string;
  outcome: AgentOutcome;
  result?: TResult;
  error?: {
    /** Maps to an ErrorCode; the route layer localizes it. */
    code: string;
    /** Engineer-facing. Logged, never returned to the browser. */
    detail?: string;
    retryable: boolean;
  };
  /** Populated only when the workflow actually reports one. Usually absent. */
  n8nExecutionId?: string;
  durationMs: number;
  /** Raw transport frames, kept for debugging. Never sent to the client. */
  diagnostics?: Record<string, unknown>;
}

/* ------------------------------ Knowledge -------------------------------- */

export const knowledgeAskPayloadSchema = z.object({
  question: z.string().trim().min(1).max(4000),
  /**
   * Stable per-conversation id. The n8n workflow keys a 10-turn buffer memory
   * on it, so reusing it is what makes a conversation a conversation.
   */
  sessionId: z.string().min(8).max(128),
});

export type KnowledgeAskPayload = z.infer<typeof knowledgeAskPayloadSchema>;

export interface Citation {
  kind: 'document' | 'web';
  /** Filename for a document, hostname for a web source. */
  label: string;
  url?: string;
}

export interface KnowledgeAskResult {
  answer: string;
  citations: Citation[];
  /** Which corpus the agent said it used, normalized from its first line. */
  sourceBasis: 'documents' | 'web' | 'both' | 'none';
  /**
   * The workflow emits no confidence score. This stays undefined rather than
   * being invented; the UI hides the indicator when it is absent (§16).
   */
  confidence?: number;
}

/* ------------------------------- Creative -------------------------------- */

/** The only two ratios the Creative workflow's image URL builder handles. */
export const CREATIVE_ASPECT_RATIOS = ['16:9', '9:16'] as const;
export type CreativeAspectRatio = (typeof CREATIVE_ASPECT_RATIOS)[number];

export const creativeGeneratePayloadSchema = z.object({
  prompt: z.string().trim().min(3).max(2000),
  mediaType: z.enum(['IMAGE', 'VIDEO']),
  aspectRatio: z.enum(CREATIVE_ASPECT_RATIOS).default('16:9'),
  sessionId: z.string().min(8).max(128),
});

export type CreativeGeneratePayload = z.infer<typeof creativeGeneratePayloadSchema>;

export interface CreativeGenerateResult {
  /** What the agent actually produced, which may differ from what was asked. */
  producedKind: 'IMAGE' | 'VIDEO';
  title: string;
  /** English prompt the Content Director wrote, as sent to the image model. */
  promptUsed?: string;
  /** Arabic marketing caption the workflow generates alongside the asset. */
  caption?: string;
  aspectRatio: CreativeAspectRatio;
  /** Inline bytes returned by the workflow, ready to be persisted to storage. */
  media?: {
    base64: string;
    mimeType: string;
  };
  /**
   * Set when a VIDEO request was downgraded to a key-frame image because the
   * workflow has video generation disabled. The UI surfaces this explicitly
   * rather than presenting a still as if it were the requested video.
   */
  downgradedFrom?: 'VIDEO';
  /** Agent's conversational reply, in the user's language. */
  agentReply?: string;
}

/* ----------------------------- Advertising ------------------------------- */

/** Placements the workflow's creative validator recognises. */
export const META_PLACEMENTS = [
  'Feed 1:1',
  'Feed 4:5',
  'Stories / Reels 9:16',
  'Landscape 1.91:1',
] as const;
export type MetaPlacement = (typeof META_PLACEMENTS)[number];

/**
 * Catalogue-safe key for each placement.
 *
 * The placement values are Meta's own strings and two of them contain
 * characters that cannot be used as translation keys: next-intl resolves a key
 * by splitting on dots, so "Landscape 1.91:1" would be looked up as
 * `…placements.Landscape 1` -> `91:1` and never found. Mapping to a slug keeps
 * the external vocabulary out of the catalogue entirely.
 */
export const PLACEMENT_KEYS: Record<MetaPlacement, string> = {
  'Feed 1:1': 'feed_square',
  'Feed 4:5': 'feed_portrait',
  'Stories / Reels 9:16': 'stories_reels',
  'Landscape 1.91:1': 'landscape',
};

/** Aspect ratio each placement demands, and the tolerance the validator allows. */
export const PLACEMENT_RATIOS: Record<MetaPlacement, number> = {
  'Feed 1:1': 1,
  'Feed 4:5': 0.8,
  'Stories / Reels 9:16': 0.5625,
  'Landscape 1.91:1': 1.9104,
};
export const PLACEMENT_RATIO_TOLERANCE = 0.03;
export const CREATIVE_MIN_SIDE_PX = 1080;
export const META_MAX_IMAGE_BYTES = 31_457_280; // 30 MiB
export const META_MAX_VIDEO_BYTES = 4_294_967_296; // 4 GiB
export const META_PRIMARY_TEXT_MAX = 125;
export const META_HEADLINE_MAX = 40;

export const advertisingSubmitPayloadSchema = z.object({
  campaignName: z.string().trim().min(1).max(200),
  adName: z.string().trim().min(1).max(200),
  primaryText: z.string().trim().min(1).max(2000),
  headline: z.string().trim().min(1).max(255),
  description: z.string().trim().max(500).optional(),
  destinationUrl: z.string().url(),
  callToAction: z.string().default('LEARN_MORE'),
  placement: z.enum(META_PLACEMENTS),
  /** ISO date, `YYYY-MM-DD`, as the workflow's date arithmetic expects. */
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Major units. The workflow multiplies by 100 for Meta. */
  lifetimeBudget: z.number().positive(),
  savedAudienceId: z.string().optional(),
  savedAudienceName: z.string().optional(),
  audienceNotes: z.string().max(1000).optional(),
  ageMin: z.number().int().min(13).max(65).optional(),
  ageMax: z.number().int().min(13).max(65).optional(),
  genders: z.enum(['all', 'male', 'female']).default('all'),
  countries: z.array(z.string().length(2)).min(1),
  cities: z.array(z.string()).default([]),
  /** The creative, as bytes plus its type. Uploaded on the first chat message. */
  creative: z.object({
    base64: z.string().min(1),
    mimeType: z.string().min(1),
    fileName: z.string().min(1),
  }),
  sessionId: z.string().min(8).max(128),
});

export type AdvertisingSubmitPayload = z.infer<typeof advertisingSubmitPayloadSchema>;

export interface AdvertisingSubmitResult {
  metaCampaignId?: string;
  metaAdSetId?: string;
  metaAdId?: string;
  /**
   * Always 'PAUSED' on success: the workflow creates every object paused and
   * never activates. Modelled explicitly so the UI cannot imply live spend.
   */
  objectStatus: 'PAUSED';
  audienceLabel?: string;
  agentReply?: string;
  /** Set when the agent rejected the submission for missing/invalid input. */
  rejection?: {
    reason: string;
    missingFields: string[];
  };
}

/* ------------------------------- Adapter --------------------------------- */

/**
 * What every agent adapter implements. The gateway depends on this interface
 * and nothing else.
 */
export interface AgentAdapter<TPayload = unknown, TResult = unknown> {
  readonly agent: AgentName;
  /** Actions this adapter can service. */
  readonly actions: readonly AgentAction[];
  /**
   * True when the adapter has the configuration it needs to make a real call.
   * The UI renders an explicit "not configured" state when this is false,
   * rather than a fabricated success (§52).
   */
  isConfigured(): boolean;
  /** Declares what the underlying workflow can and cannot do right now. */
  capabilities(): AgentCapabilities;
  execute(request: AgentRequest<TPayload>): Promise<AgentResponse<TResult>>;
}

/**
 * Honest capability reporting.
 *
 * Discovered limits live here, not in UI copy, so a single place governs what
 * the product claims. `unavailable` entries carry a machine-readable reason the
 * UI localizes and shows to the user.
 */
export interface AgentCapabilities {
  agent: AgentName;
  configured: boolean;
  /** Feature flags the adapter can honestly claim. */
  supports: {
    streaming: boolean;
    /** The workflow accepts a `locale` field or otherwise honours language. */
    localeMetadata: boolean;
    /** The workflow posts progress/completion back to the SaaS. */
    callbacks: boolean;
    /** A workflow execution id is returned and can be stored. */
    executionIds: boolean;
    fileUploads: boolean;
  };
  /** Capabilities the workflow explicitly cannot deliver, with the reason. */
  unavailable: Array<{
    capability: string;
    /** i18n key under `errors.` or a feature-specific namespace. */
    reasonKey: string;
  }>;
}
