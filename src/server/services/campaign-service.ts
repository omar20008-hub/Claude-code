import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { withTenant } from '@/server/tenancy/context';
import { campaigns, assets, notifications, users, campaignMetrics } from '@/server/db/schema';
import { invokeAgent } from '@/server/agents/gateway';
import { getAsset } from './asset-service';
import { signedDownloadUrl } from '@/server/storage/object-store';
import { AppError } from '@/lib/errors';
import { recordAudit } from './audit';
import {
  META_CONFIG,
  META_ACCEPTED_MIME_TYPES,
} from '@/server/agents/adapters/advertising';
import {
  META_HEADLINE_MAX,
  META_PRIMARY_TEXT_MAX,
  PLACEMENT_RATIOS,
  PLACEMENT_RATIO_TOLERANCE,
  CREATIVE_MIN_SIDE_PX,
  type AdvertisingSubmitPayload,
  type AdvertisingSubmitResult,
  type MetaPlacement,
} from '@/server/agents/contracts';
import type { Locale } from '@/i18n/config';
import type { Campaign } from '@/server/db/schema';

/**
 * Advertising campaign domain service (§20, §21, §22, §29).
 *
 * Two rules govern everything here:
 *
 *  1. A campaign reaches Meta only after an explicit, recorded human approval.
 *  2. It reaches Meta at most once, guaranteed by the database rather than by
 *     careful coding.
 */

/** Permitted status transitions. Anything else is rejected. */
const TRANSITIONS: Record<Campaign['status'], Campaign['status'][]> = {
  DRAFT: ['READY', 'DRAFT'],
  READY: ['LAUNCHING', 'DRAFT'],
  LAUNCHING: ['PAUSED', 'ACTIVE', 'FAILED'],
  // A campaign created on Meta is paused; activation happens in Ads Manager,
  // and a future sync can move it to ACTIVE or COMPLETED.
  PAUSED: ['ACTIVE', 'COMPLETED'],
  ACTIVE: ['PAUSED', 'COMPLETED'],
  COMPLETED: [],
  FAILED: ['DRAFT', 'READY'],
};

function assertTransition(from: Campaign['status'], to: Campaign['status']): void {
  if (!TRANSITIONS[from]?.includes(to)) {
    throw new AppError('invalid_state_transition', {
      internalMessage: `Campaign cannot move ${from} -> ${to}`,
    });
  }
}

export interface CampaignWarning {
  /** i18n key under `advertising.wizard.review.warningItems`. */
  key: string;
  params?: Record<string, string | number>;
}

/**
 * Pre-flight checks shown on the review screen (§21).
 *
 * These mirror the validations the n8n workflow performs, so a user learns
 * about a problem before submission rather than watching it fail downstream.
 * They are warnings, not blocks, except where the workflow would hard-reject.
 */
export function reviewCampaign(
  campaign: Campaign,
  asset?: { width: number | null; height: number | null; mimeType: string | null },
): { warnings: CampaignWarning[]; blockers: CampaignWarning[] } {
  const warnings: CampaignWarning[] = [];
  const blockers: CampaignWarning[] = [];

  if (campaign.primaryText && campaign.primaryText.length > META_PRIMARY_TEXT_MAX) {
    // The workflow's validator treats this as an error, so it blocks.
    blockers.push({
      key: 'longPrimaryText',
      params: { length: campaign.primaryText.length, max: META_PRIMARY_TEXT_MAX },
    });
  }
  if (campaign.headline && campaign.headline.length > META_HEADLINE_MAX) {
    blockers.push({
      key: 'longHeadline',
      params: { length: campaign.headline.length, max: META_HEADLINE_MAX },
    });
  }

  if (campaign.startDate && campaign.endDate) {
    const durationMs = campaign.endDate.getTime() - campaign.startDate.getTime();
    if (durationMs < 24 * 60 * 60 * 1000) {
      warnings.push({ key: 'shortSchedule' });
    }
  }

  // A budget above ~50,000 in major units is unusual enough to be worth a
  // second look before it is committed.
  if (campaign.lifetimeBudgetMinor && campaign.lifetimeBudgetMinor > 5_000_000) {
    warnings.push({ key: 'largeBudget' });
  }

  const hasNarrowing =
    campaign.ageMin !== null ||
    campaign.ageMax !== null ||
    campaign.genders !== 'all' ||
    Boolean(campaign.savedAudienceId) ||
    (campaign.cities?.length ?? 0) > 0;
  if (!hasNarrowing) {
    warnings.push({ key: 'noAudienceNarrowing' });
  }

  // Creative specs, mirroring the workflow's "Validate Creative" node exactly.
  if (asset?.width && asset?.height && campaign.placement) {
    const expected = PLACEMENT_RATIOS[campaign.placement as MetaPlacement];
    if (expected) {
      const actual = asset.width / asset.height;
      if (Math.abs(actual - expected) / expected > PLACEMENT_RATIO_TOLERANCE) {
        blockers.push({
          key: 'specMismatch',
          params: {
            ratio: actual.toFixed(3),
            placement: campaign.placement,
            expected: expected.toFixed(3),
          },
        });
      }
    }
    if (Math.min(asset.width, asset.height) < CREATIVE_MIN_SIDE_PX) {
      blockers.push({
        key: 'specMismatch',
        params: {
          ratio: `${asset.width}×${asset.height}`,
          placement: campaign.placement,
          expected: `≥ ${CREATIVE_MIN_SIDE_PX}px`,
        },
      });
    }
  }

  return { warnings, blockers };
}

/** Fields that must be present before a campaign can be approved. */
function assertComplete(campaign: Campaign): void {
  const missing: Array<{ path: string; rule: string }> = [];

  const required: Array<[keyof Campaign, string]> = [
    ['name', 'name'],
    ['primaryText', 'primaryText'],
    ['headline', 'headline'],
    ['destinationUrl', 'destinationUrl'],
    ['lifetimeBudgetMinor', 'lifetimeBudget'],
    ['startDate', 'startDate'],
    ['endDate', 'endDate'],
    ['assetId', 'assetId'],
    ['placement', 'placement'],
  ];

  for (const [field, path] of required) {
    const value = campaign[field];
    if (value === null || value === undefined || value === '') {
      missing.push({ path, rule: 'required' });
    }
  }

  if (missing.length > 0) {
    throw new AppError('validation_failed', { fields: missing });
  }
}

export async function getCampaign(params: {
  organizationId: string;
  campaignId: string;
}): Promise<Campaign> {
  const rows = await withTenant({ organizationId: params.organizationId }, (tx) =>
    tx
      .select()
      .from(campaigns)
      .where(
        and(
          eq(campaigns.id, params.campaignId),
          eq(campaigns.organizationId, params.organizationId),
          isNull(campaigns.deletedAt),
        ),
      )
      .limit(1),
  );

  const campaign = rows[0];
  if (!campaign) throw new AppError('not_found');
  return campaign;
}

export async function listCampaigns(params: {
  organizationId: string;
  status?: Campaign['status'];
  limit?: number;
  offset?: number;
}) {
  const limit = Math.min(params.limit ?? 25, 100);
  const offset = Math.max(params.offset ?? 0, 0);

  const filters: SQL[] = [
    eq(campaigns.organizationId, params.organizationId),
    isNull(campaigns.deletedAt),
  ];
  if (params.status) filters.push(eq(campaigns.status, params.status));
  const where = and(...filters);

  return withTenant({ organizationId: params.organizationId }, async (tx) => {
    const [rows, counted] = await Promise.all([
      tx
        .select({
          campaign: campaigns,
          assetTitle: assets.title,
          createdByName: users.name,
        })
        .from(campaigns)
        .leftJoin(assets, eq(assets.id, campaigns.assetId))
        .leftJoin(users, eq(users.id, campaigns.createdByUserId))
        .where(where)
        .orderBy(desc(campaigns.createdAt))
        .limit(limit)
        .offset(offset),
      tx.select({ count: sql<number>`count(*)::int` }).from(campaigns).where(where),
    ]);

    return { items: rows, total: counted[0]?.count ?? 0 };
  });
}

export interface CampaignDraftInput {
  name: string;
  brief?: string;
  primaryText?: string;
  headline?: string;
  description?: string;
  destinationUrl?: string;
  callToAction?: string;
  placement?: MetaPlacement;
  savedAudienceId?: string;
  savedAudienceName?: string;
  audienceNotes?: string;
  ageMin?: number;
  ageMax?: number;
  genders?: 'all' | 'male' | 'female';
  countries?: string[];
  cities?: string[];
  /** Major units, as typed by the user. Converted to minor units here. */
  lifetimeBudget?: number;
  startDate?: string;
  endDate?: string;
  assetId?: string;
}

export async function createCampaign(params: {
  organizationId: string;
  userId: string;
  locale: Locale;
  input: CampaignDraftInput;
  correlationId: string;
}): Promise<{ id: string }> {
  const created = await withTenant(
    { organizationId: params.organizationId, userId: params.userId },
    async (tx) => {
      const [row] = await tx
        .insert(campaigns)
        .values({
          organizationId: params.organizationId,
          createdByUserId: params.userId,
          name: params.input.name.slice(0, 200),
          status: 'DRAFT',
          locale: params.locale,
          objective: META_CONFIG.objective,
          currency: META_CONFIG.currency,
          metaAdAccountId: META_CONFIG.adAccountId,
          metaPageId: META_CONFIG.pageId,
          ...draftToColumns(params.input),
        })
        .returning({ id: campaigns.id });

      if (!row) {
        throw new AppError('internal_error', {
          internalMessage: 'campaign insert returned no row',
        });
      }
      return row;
    },
  );

  await recordAudit({
    organizationId: params.organizationId,
    userId: params.userId,
    action: 'campaign.created',
    resourceType: 'campaign',
    resourceId: created.id,
    status: 'SUCCESS',
    correlationId: params.correlationId,
    metadata: { name: params.input.name },
  });

  return created;
}

function draftToColumns(input: CampaignDraftInput): Record<string, unknown> {
  const columns: Record<string, unknown> = {};

  if (input.brief !== undefined) columns.brief = input.brief;
  if (input.primaryText !== undefined) columns.primaryText = input.primaryText;
  if (input.headline !== undefined) columns.headline = input.headline;
  if (input.description !== undefined) columns.description = input.description;
  if (input.destinationUrl !== undefined) columns.destinationUrl = input.destinationUrl;
  if (input.callToAction !== undefined) columns.callToAction = input.callToAction;
  if (input.placement !== undefined) columns.placement = input.placement;
  if (input.savedAudienceId !== undefined) columns.savedAudienceId = input.savedAudienceId;
  if (input.savedAudienceName !== undefined) columns.savedAudienceName = input.savedAudienceName;
  if (input.audienceNotes !== undefined) columns.audienceNotes = input.audienceNotes;
  if (input.ageMin !== undefined) columns.ageMin = input.ageMin;
  if (input.ageMax !== undefined) columns.ageMax = input.ageMax;
  if (input.genders !== undefined) columns.genders = input.genders;
  if (input.countries !== undefined) columns.countries = input.countries;
  if (input.cities !== undefined) columns.cities = input.cities;
  if (input.assetId !== undefined) columns.assetId = input.assetId;

  // Money crosses into minor units exactly once, here, so no other code has to
  // remember which unit it is holding.
  if (input.lifetimeBudget !== undefined) {
    columns.lifetimeBudgetMinor = Math.round(input.lifetimeBudget * 100);
  }

  // Dates are interpreted in the ad account's zone (+03:00), matching the
  // ad set times the workflow builds.
  if (input.startDate !== undefined) {
    columns.startDate = new Date(`${input.startDate}T00:00:00+03:00`);
  }
  if (input.endDate !== undefined) {
    columns.endDate = new Date(`${input.endDate}T23:59:00+03:00`);
  }

  return columns;
}

export async function updateCampaign(params: {
  organizationId: string;
  userId: string;
  campaignId: string;
  input: CampaignDraftInput;
  correlationId: string;
}): Promise<void> {
  const campaign = await getCampaign(params);

  // Once a campaign has gone to Meta, editing the local record would make it
  // disagree with what is actually live.
  if (campaign.status !== 'DRAFT' && campaign.status !== 'READY' && campaign.status !== 'FAILED') {
    throw new AppError('invalid_state_transition', {
      internalMessage: `Cannot edit a campaign in status ${campaign.status}`,
    });
  }

  await withTenant(
    { organizationId: params.organizationId, userId: params.userId },
    (tx) =>
      tx
        .update(campaigns)
        .set({
          ...(params.input.name ? { name: params.input.name.slice(0, 200) } : {}),
          ...draftToColumns(params.input),
          // Any edit invalidates a previous approval: what was approved is no
          // longer what would be submitted.
          status: 'DRAFT',
          approvedByUserId: null,
          approvedAt: null,
          approvedSnapshot: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(campaigns.id, params.campaignId),
            eq(campaigns.organizationId, params.organizationId),
          ),
        ),
  );

  await recordAudit({
    organizationId: params.organizationId,
    userId: params.userId,
    action: 'campaign.updated',
    resourceType: 'campaign',
    resourceId: params.campaignId,
    status: 'SUCCESS',
    correlationId: params.correlationId,
  });
}

/**
 * Records explicit approval (§21).
 *
 * The snapshot is the point: it freezes exactly what the approver saw. If the
 * campaign is later edited the approval is cleared, so the thing submitted to
 * Meta is always the thing a named person signed off on, and the audit trail
 * can prove it.
 */
export async function approveCampaign(params: {
  organizationId: string;
  userId: string;
  campaignId: string;
  correlationId: string;
}): Promise<void> {
  const campaign = await getCampaign(params);
  assertTransition(campaign.status, 'READY');
  assertComplete(campaign);

  const asset = campaign.assetId
    ? await getAsset({ organizationId: params.organizationId, assetId: campaign.assetId })
    : undefined;

  const { blockers } = reviewCampaign(campaign, asset);
  if (blockers.length > 0) {
    throw new AppError('campaign_not_launchable', {
      internalMessage: `Blocking issues: ${blockers.map((b) => b.key).join(', ')}`,
      params: { count: blockers.length },
    });
  }

  const snapshot = {
    name: campaign.name,
    objective: campaign.objective,
    primaryText: campaign.primaryText,
    headline: campaign.headline,
    destinationUrl: campaign.destinationUrl,
    placement: campaign.placement,
    lifetimeBudgetMinor: campaign.lifetimeBudgetMinor,
    currency: campaign.currency,
    startDate: campaign.startDate?.toISOString(),
    endDate: campaign.endDate?.toISOString(),
    audience: {
      savedAudienceId: campaign.savedAudienceId,
      ageMin: campaign.ageMin,
      ageMax: campaign.ageMax,
      genders: campaign.genders,
      countries: campaign.countries,
      cities: campaign.cities,
    },
    assetId: campaign.assetId,
    adAccountId: campaign.metaAdAccountId,
    approvedAt: new Date().toISOString(),
  };

  await withTenant(
    { organizationId: params.organizationId, userId: params.userId },
    async (tx) => {
      await tx
        .update(campaigns)
        .set({
          status: 'READY',
          approvedByUserId: params.userId,
          approvedAt: new Date(),
          approvedSnapshot: snapshot,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(campaigns.id, params.campaignId),
            eq(campaigns.organizationId, params.organizationId),
            eq(campaigns.status, 'DRAFT'),
          ),
        );

      // Atomic with the approval: an approved campaign with no audit record
      // would be a compliance gap.
      await recordAudit(
        {
          organizationId: params.organizationId,
          userId: params.userId,
          action: 'campaign.approved',
          resourceType: 'campaign',
          resourceId: params.campaignId,
          status: 'SUCCESS',
          correlationId: params.correlationId,
          metadata: { snapshot },
        },
        tx,
      );
    },
  );
}

export interface LaunchResult {
  status: Campaign['status'];
  metaCampaignId?: string;
  metaAdSetId?: string;
  metaAdId?: string;
  /** Always PAUSED on success — the workflow never activates. */
  objectStatus?: 'PAUSED';
  error?: { code: string; retryable: boolean; detail?: string };
}

/**
 * Submits an approved campaign to Meta.
 *
 * DUPLICATE PROTECTION (§29). Three layers, in order of how early they stop a
 * duplicate:
 *
 *  1. A conditional UPDATE claims the campaign: `SET status='LAUNCHING' WHERE
 *     status='READY'`. Only one concurrent caller can match, because the row is
 *     locked for the duration. The loser sees zero rows updated and stops.
 *  2. `launchIdempotencyKey` is written in that same statement and is covered
 *     by a partial unique index, so a retry carrying the same key collides at
 *     the database rather than reaching Meta.
 *  3. `metaCampaignId` has its own unique index, so even a bug that got past
 *     both could not record two rows against one Meta campaign.
 *
 * Layer 1 is what actually prevents double spend; the others are the backstops.
 */
export async function launchCampaign(params: {
  organizationId: string;
  userId: string;
  campaignId: string;
  locale: Locale;
  correlationId: string;
  idempotencyKey: string;
}): Promise<LaunchResult> {
  const campaign = await getCampaign(params);

  if (campaign.metaCampaignId) {
    throw new AppError('campaign_already_launched', {
      internalMessage: `Campaign ${campaign.id} already has Meta id ${campaign.metaCampaignId}`,
    });
  }
  if (campaign.status !== 'READY') {
    throw new AppError('campaign_not_launchable', {
      internalMessage: `Campaign is ${campaign.status}, expected READY`,
    });
  }
  if (!campaign.approvedAt || !campaign.approvedByUserId) {
    throw new AppError('campaign_not_launchable', {
      internalMessage: 'Campaign has no recorded approval',
    });
  }

  assertComplete(campaign);

  // --- Layer 1: claim the campaign ----------------------------------------
  const claimed = await withTenant(
    { organizationId: params.organizationId, userId: params.userId },
    (tx) =>
      tx
        .update(campaigns)
        .set({
          status: 'LAUNCHING',
          launchIdempotencyKey: params.idempotencyKey,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(campaigns.id, params.campaignId),
            eq(campaigns.organizationId, params.organizationId),
            // The guard: only a READY campaign can be claimed, and only once.
            eq(campaigns.status, 'READY'),
            isNull(campaigns.metaCampaignId),
          ),
        )
        .returning({ id: campaigns.id }),
  );

  if (claimed.length === 0) {
    // Someone else claimed it between our read and our write.
    throw new AppError('campaign_already_launched', {
      internalMessage: `Campaign ${params.campaignId} was already claimed for launch`,
    });
  }

  // --- Fetch the creative --------------------------------------------------
  const asset = await getAsset({
    organizationId: params.organizationId,
    assetId: campaign.assetId!,
  });

  if (!asset.storageKey || !asset.mimeType) {
    await markLaunchFailed(params, 'validation_failed', 'Creative asset has no stored file');
    throw new AppError('validation_failed', {
      fields: [{ path: 'assetId', rule: 'invalid' }],
    });
  }

  if (!META_ACCEPTED_MIME_TYPES.includes(asset.mimeType as never)) {
    await markLaunchFailed(
      params,
      'unsupported_media_type',
      `Meta does not accept ${asset.mimeType}`,
    );
    throw new AppError('unsupported_media_type', {
      internalMessage: `Meta does not accept ${asset.mimeType}`,
    });
  }

  // The workflow reads the creative from the first chat message, so the bytes
  // have to travel with the request.
  const downloadUrl = await signedDownloadUrl(asset.storageKey, { expiresIn: 300 });
  const fileResponse = await fetch(downloadUrl);
  if (!fileResponse.ok) {
    await markLaunchFailed(params, 'internal_error', 'Could not read creative from storage');
    throw new AppError('internal_error', {
      internalMessage: `Storage returned ${fileResponse.status} for ${asset.storageKey}`,
    });
  }
  const creativeBuffer = Buffer.from(await fileResponse.arrayBuffer());

  const payload: AdvertisingSubmitPayload = {
    campaignName: campaign.name,
    adName: `${campaign.name} — Ad`.slice(0, 200),
    primaryText: campaign.primaryText!,
    headline: campaign.headline!,
    description: campaign.description ?? undefined,
    destinationUrl: campaign.destinationUrl!,
    callToAction: campaign.callToAction ?? 'LEARN_MORE',
    placement: (campaign.placement ?? 'Feed 1:1') as MetaPlacement,
    startDate: toIsoDate(campaign.startDate!),
    endDate: toIsoDate(campaign.endDate!),
    lifetimeBudget: campaign.lifetimeBudgetMinor! / 100,
    savedAudienceId: campaign.savedAudienceId ?? undefined,
    savedAudienceName: campaign.savedAudienceName ?? undefined,
    audienceNotes: campaign.audienceNotes ?? undefined,
    ageMin: campaign.ageMin ?? undefined,
    ageMax: campaign.ageMax ?? undefined,
    genders: (campaign.genders ?? 'all') as 'all' | 'male' | 'female',
    countries: campaign.countries,
    cities: campaign.cities,
    creative: {
      base64: creativeBuffer.toString('base64'),
      mimeType: asset.mimeType,
      fileName: `${asset.title.replace(/[^\p{L}\p{N}._-]+/gu, '_')}.${asset.storageKey.split('.').pop()}`,
    },
    sessionId: `aiw_ad_${params.campaignId.replace(/-/g, '')}`,
  };

  const { response } = await invokeAgent<AdvertisingSubmitPayload, AdvertisingSubmitResult>({
    organizationId: params.organizationId,
    userId: params.userId,
    action: 'advertising.submit_campaign',
    locale: params.locale,
    correlationId: params.correlationId,
    // Layer 2: the gateway short-circuits a repeat of the same key.
    idempotencyKey: params.idempotencyKey,
    payload,
    metadata: { campaignId: params.campaignId },
  });

  if (response.outcome !== 'COMPLETED' || !response.result?.metaCampaignId) {
    const code = response.error?.code ?? 'agent_failed';
    await markLaunchFailed(params, code, response.error?.detail);

    await notifyCampaign(params, 'CAMPAIGN_FAILED', 'notifications.messages.campaignFailed', {
      name: campaign.name,
    });

    return {
      status: 'FAILED',
      error: { code, retryable: response.error?.retryable ?? false, detail: response.error?.detail },
    };
  }

  const result = response.result;

  await withTenant(
    { organizationId: params.organizationId, userId: params.userId },
    async (tx) => {
      await tx
        .update(campaigns)
        .set({
          // PAUSED, not ACTIVE: the workflow creates every Meta object paused
          // and never activates it. Claiming ACTIVE here would be a lie the UI
          // would then repeat.
          status: 'PAUSED',
          metaCampaignId: result.metaCampaignId,
          metaAdSetId: result.metaAdSetId ?? null,
          metaAdId: result.metaAdId ?? null,
          metaObjectStatus: result.objectStatus,
          launchedAt: new Date(),
          lastErrorCode: null,
          lastErrorDetail: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(campaigns.id, params.campaignId),
            eq(campaigns.organizationId, params.organizationId),
          ),
        );

      await recordAudit(
        {
          organizationId: params.organizationId,
          userId: params.userId,
          action: 'campaign.launched',
          resourceType: 'campaign',
          resourceId: params.campaignId,
          status: 'SUCCESS',
          correlationId: params.correlationId,
          metadata: {
            metaCampaignId: result.metaCampaignId,
            metaAdSetId: result.metaAdSetId,
            metaAdId: result.metaAdId,
            objectStatus: result.objectStatus,
            budgetMinor: campaign.lifetimeBudgetMinor,
            currency: campaign.currency,
          },
        },
        tx,
      );
    },
  );

  await notifyCampaign(params, 'CAMPAIGN_SUBMITTED', 'notifications.messages.campaignSubmitted', {
    name: campaign.name,
  });

  return {
    status: 'PAUSED',
    metaCampaignId: result.metaCampaignId,
    metaAdSetId: result.metaAdSetId,
    metaAdId: result.metaAdId,
    objectStatus: result.objectStatus,
  };
}

function toIsoDate(date: Date): string {
  // The workflow expects `YYYY-MM-DD` in the ad account's zone.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: META_CONFIG.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

async function markLaunchFailed(
  params: { organizationId: string; userId: string; campaignId: string; correlationId: string },
  code: string,
  detail?: string,
): Promise<void> {
  await withTenant(
    { organizationId: params.organizationId, userId: params.userId },
    async (tx) => {
      await tx
        .update(campaigns)
        .set({
          status: 'FAILED',
          lastErrorCode: code,
          lastErrorDetail: detail?.slice(0, 4000) ?? null,
          // Cleared so the user can correct the problem and submit again; the
          // Meta-id uniqueness index still prevents a real duplicate.
          launchIdempotencyKey: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(campaigns.id, params.campaignId),
            eq(campaigns.organizationId, params.organizationId),
          ),
        );

      await recordAudit(
        {
          organizationId: params.organizationId,
          userId: params.userId,
          action: 'campaign.launch_failed',
          resourceType: 'campaign',
          resourceId: params.campaignId,
          status: 'FAILURE',
          correlationId: params.correlationId,
          metadata: { errorCode: code },
        },
        tx,
      );
    },
  );
}

async function notifyCampaign(
  params: { organizationId: string; userId: string; campaignId: string },
  kind: 'CAMPAIGN_SUBMITTED' | 'CAMPAIGN_FAILED',
  messageKey: string,
  messageParams: Record<string, string | number>,
): Promise<void> {
  await withTenant({ organizationId: params.organizationId }, (tx) =>
    tx.insert(notifications).values({
      organizationId: params.organizationId,
      userId: params.userId,
      kind,
      messageKey,
      messageParams,
      href: `/campaigns/${params.campaignId}`,
    }),
  );
}

export async function deleteCampaign(params: {
  organizationId: string;
  userId: string;
  campaignId: string;
  correlationId: string;
}): Promise<void> {
  const campaign = await getCampaign(params);

  if (campaign.status === 'LAUNCHING') {
    throw new AppError('conflict', {
      internalMessage: 'Cannot delete a campaign mid-submission',
    });
  }

  await withTenant(
    { organizationId: params.organizationId, userId: params.userId },
    (tx) =>
      tx
        .update(campaigns)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(campaigns.id, params.campaignId),
            eq(campaigns.organizationId, params.organizationId),
          ),
        ),
  );

  await recordAudit({
    organizationId: params.organizationId,
    userId: params.userId,
    action: 'campaign.deleted',
    resourceType: 'campaign',
    resourceId: params.campaignId,
    status: 'SUCCESS',
    correlationId: params.correlationId,
    metadata: {
      // Deleting locally does not remove the Meta objects; record that clearly.
      metaCampaignId: campaign.metaCampaignId,
      metaObjectsRemain: Boolean(campaign.metaCampaignId),
    },
  });
}

/**
 * Performance metrics for one campaign.
 *
 * Returns `available: false` whenever no metrics have ever been recorded, which
 * is the current state for every campaign: the n8n advertising workflow has no
 * Insights node, so nothing writes to campaign_metrics. The UI renders an
 * explicit explanation instead of zeros, because zeros would read as "this
 * campaign got no impressions" rather than "we cannot see them" (§36, §52).
 */
export async function getCampaignPerformance(params: {
  organizationId: string;
  campaignId: string;
}): Promise<
  | { available: false }
  | {
      available: true;
      impressions: number;
      clicks: number;
      spendMinor: number;
      conversions: number;
      conversionValueMinor: number;
      ctr: number | null;
      cpcMinor: number | null;
      roas: number | null;
      lastFetchedAt: Date;
    }
> {
  return withTenant({ organizationId: params.organizationId }, async (tx) => {
    const rows = await tx
      .select({
        impressions: sql<number>`COALESCE(sum(${campaignMetrics.impressions}), 0)::bigint`,
        clicks: sql<number>`COALESCE(sum(${campaignMetrics.clicks}), 0)::bigint`,
        spendMinor: sql<number>`COALESCE(sum(${campaignMetrics.spendMinor}), 0)::bigint`,
        conversions: sql<number>`COALESCE(sum(${campaignMetrics.conversions}), 0)::bigint`,
        conversionValueMinor: sql<number>`COALESCE(sum(${campaignMetrics.conversionValueMinor}), 0)::bigint`,
        lastFetchedAt: sql<Date | null>`max(${campaignMetrics.fetchedAt})`,
        rowCount: sql<number>`count(*)::int`,
      })
      .from(campaignMetrics)
      .where(
        and(
          eq(campaignMetrics.campaignId, params.campaignId),
          eq(campaignMetrics.organizationId, params.organizationId),
        ),
      );

    const row = rows[0];
    if (!row || row.rowCount === 0 || !row.lastFetchedAt) {
      return { available: false as const };
    }

    const impressions = Number(row.impressions);
    const clicks = Number(row.clicks);
    const spendMinor = Number(row.spendMinor);
    const conversionValueMinor = Number(row.conversionValueMinor);

    return {
      available: true as const,
      impressions,
      clicks,
      spendMinor,
      conversions: Number(row.conversions),
      conversionValueMinor,
      // Guarded so an empty denominator produces null (rendered "—") rather
      // than NaN or Infinity leaking into the UI.
      ctr: impressions > 0 ? clicks / impressions : null,
      cpcMinor: clicks > 0 ? spendMinor / clicks : null,
      roas: spendMinor > 0 ? conversionValueMinor / spendMinor : null,
      lastFetchedAt: new Date(row.lastFetchedAt),
    };
  });
}
