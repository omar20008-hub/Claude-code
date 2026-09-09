import { and, desc, asc, eq, gte, isNull, lte, sql, ilike, type SQL } from 'drizzle-orm';
import { withTenant } from '@/server/tenancy/context';
import { assets, campaigns, notifications } from '@/server/db/schema';
import { invokeAgent } from '@/server/agents/gateway';
import {
  buildStorageKey,
  deleteObject,
  putObject,
  signedDownloadUrl,
  validateFile,
} from '@/server/storage/object-store';
import { isStorageConfigured } from '@/server/config/env';
import { AppError } from '@/lib/errors';
import { uuid, secureToken } from '@/lib/ids';
import { recordAudit } from './audit';
import { CREATIVE_IMAGE_MODEL, CREATIVE_DIMENSIONS } from '@/server/agents/adapters/creative';
import type {
  CreativeGeneratePayload,
  CreativeGenerateResult,
  CreativeAspectRatio,
} from '@/server/agents/contracts';
import type { Locale } from '@/i18n/config';

/**
 * Creative Studio and Asset Library (§18, §19).
 */

export interface GenerateResult {
  jobId?: string;
  assetId?: string;
  /** True when a video was requested but a key-frame image came back. */
  downgradedToImage: boolean;
  title?: string;
  caption?: string;
  promptUsed?: string;
  error?: { code: string; retryable: boolean };
}

/**
 * Runs a generation and persists the result.
 *
 * The agent returns bytes inline. Those bytes are validated by magic number and
 * written to object storage before an asset row is marked STORED, so the
 * library never lists an asset whose file is missing.
 */
export async function generateAsset(params: {
  organizationId: string;
  userId: string;
  prompt: string;
  mediaType: 'IMAGE' | 'VIDEO';
  aspectRatio: CreativeAspectRatio;
  locale: Locale;
  correlationId: string;
  idempotencyKey?: string;
}): Promise<GenerateResult> {
  if (!isStorageConfigured()) {
    // Refuse up front rather than burning an agent call whose output we cannot
    // keep.
    throw new AppError('storage_not_configured');
  }

  const { jobId, response } = await invokeAgent<CreativeGeneratePayload, CreativeGenerateResult>({
    organizationId: params.organizationId,
    userId: params.userId,
    action: 'creative.generate',
    locale: params.locale,
    correlationId: params.correlationId,
    idempotencyKey: params.idempotencyKey,
    payload: {
      prompt: params.prompt,
      mediaType: params.mediaType,
      aspectRatio: params.aspectRatio,
      // A fresh session each time: the Creative workflow declares
      // `loadPreviousSession: notSupported`, so there is no history to reuse
      // and a stable id would only pollute its buffer memory.
      sessionId: `aiw_gen_${secureToken(16)}`,
    },
  });

  // Bound to a const before the guard so TypeScript's narrowing survives past
  // it; a later `response.result.media` would be optional again.
  const media = response.result?.media;

  if (response.outcome !== 'COMPLETED' || !response.result || !media) {
    await notify({
      organizationId: params.organizationId,
      userId: params.userId,
      kind: 'ASSET_FAILED',
      messageKey: 'notifications.messages.assetFailed',
      messageParams: { title: params.prompt.slice(0, 60) },
    });

    return {
      jobId,
      downgradedToImage: false,
      error: {
        code: response.error?.code ?? 'agent_failed',
        retryable: response.error?.retryable ?? true,
      },
    };
  }

  const result = response.result;

  // Decode and validate. `validateFile` identifies the type from the bytes, so
  // a workflow claiming image/png while returning something else is rejected.
  let buffer: Buffer;
  try {
    buffer = Buffer.from(media.base64, 'base64');
  } catch {
    throw new AppError('agent_failed', {
      internalMessage: 'Creative agent returned undecodable base64',
    });
  }

  const validated = validateFile(buffer, media.mimeType);
  const assetId = uuid();
  const storageKey = buildStorageKey({
    organizationId: params.organizationId,
    kind: result.producedKind,
    assetId,
    extension: validated.extension,
  });

  const dimensions = CREATIVE_DIMENSIONS[result.aspectRatio];

  // Deduplicate: an identical generation within a tenant reuses the stored
  // object rather than paying for a second copy.
  const existing = await withTenant({ organizationId: params.organizationId }, (tx) =>
    tx
      .select({ id: assets.id })
      .from(assets)
      .where(
        and(
          eq(assets.organizationId, params.organizationId),
          eq(assets.checksum, validated.checksum),
          isNull(assets.deletedAt),
        ),
      )
      .limit(1),
  );

  if (existing[0]) {
    return {
      jobId,
      assetId: existing[0].id,
      downgradedToImage: result.downgradedFrom === 'VIDEO',
      title: result.title,
      caption: result.caption,
      promptUsed: result.promptUsed,
    };
  }

  await putObject({
    key: storageKey,
    body: validated.buffer,
    contentType: validated.mimeType,
    metadata: { tenant: params.organizationId, asset: assetId },
  });

  await withTenant(
    { organizationId: params.organizationId, userId: params.userId },
    async (tx) => {
      await tx.insert(assets).values({
        id: assetId,
        organizationId: params.organizationId,
        createdByUserId: params.userId,
        agentJobId: jobId ?? null,
        kind: result.producedKind,
        status: 'STORED',
        title: result.title.slice(0, 200),
        storageKey,
        mimeType: validated.mimeType,
        sizeBytes: validated.sizeBytes,
        width: dimensions?.width,
        height: dimensions?.height,
        checksum: validated.checksum,
        metadata: {
          prompt: params.prompt,
          promptUsed: result.promptUsed,
          caption: result.caption,
          aspectRatio: result.aspectRatio,
          model: CREATIVE_IMAGE_MODEL,
          requestedKind: params.mediaType,
          // Recorded so the library can explain, months later, why a video
          // request produced an image.
          downgradedFrom: result.downgradedFrom,
          agentReply: result.agentReply,
        },
      });
    },
  );

  await recordAudit({
    organizationId: params.organizationId,
    userId: params.userId,
    action: 'asset.generated',
    resourceType: 'asset',
    resourceId: assetId,
    status: 'SUCCESS',
    correlationId: params.correlationId,
    metadata: {
      kind: result.producedKind,
      sizeBytes: validated.sizeBytes,
      downgradedFrom: result.downgradedFrom,
    },
  });

  await notify({
    organizationId: params.organizationId,
    userId: params.userId,
    kind: 'ASSET_READY',
    messageKey: 'notifications.messages.assetReady',
    messageParams: { title: result.title, kind: result.producedKind },
    href: `/assets/${assetId}`,
  });

  return {
    jobId,
    assetId,
    downgradedToImage: result.downgradedFrom === 'VIDEO',
    title: result.title,
    caption: result.caption,
    promptUsed: result.promptUsed,
  };
}

export type AssetSort = 'newest' | 'oldest' | 'largest' | 'titleAsc';

export interface AssetListItem {
  id: string;
  kind: 'IMAGE' | 'VIDEO';
  title: string;
  mimeType: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  createdAt: Date;
  metadata: Record<string, unknown>;
  campaignCount: number;
}

export async function listAssets(params: {
  organizationId: string;
  kind?: 'IMAGE' | 'VIDEO';
  search?: string;
  from?: Date;
  to?: Date;
  sort?: AssetSort;
  limit?: number;
  offset?: number;
}): Promise<{ items: AssetListItem[]; total: number }> {
  const limit = Math.min(params.limit ?? 24, 100);
  const offset = Math.max(params.offset ?? 0, 0);

  const filters: SQL[] = [
    eq(assets.organizationId, params.organizationId),
    isNull(assets.deletedAt),
  ];
  if (params.kind) filters.push(eq(assets.kind, params.kind));
  if (params.from) filters.push(gte(assets.createdAt, params.from));
  if (params.to) filters.push(lte(assets.createdAt, params.to));
  if (params.search?.trim()) {
    const pattern = `%${params.search.trim()}%`;
    // Searches the title and the stored prompt, which is what people actually
    // remember about a generated image.
    filters.push(
      sql`(${ilike(assets.title, pattern)} OR ${assets.metadata}->>'prompt' ILIKE ${pattern})`,
    );
  }

  const where = and(...filters);

  const orderBy = {
    newest: desc(assets.createdAt),
    oldest: asc(assets.createdAt),
    largest: desc(assets.sizeBytes),
    titleAsc: asc(assets.title),
  }[params.sort ?? 'newest'];

  return withTenant({ organizationId: params.organizationId }, async (tx) => {
    const [rows, counted] = await Promise.all([
      tx
        .select({
          id: assets.id,
          kind: assets.kind,
          title: assets.title,
          mimeType: assets.mimeType,
          sizeBytes: assets.sizeBytes,
          width: assets.width,
          height: assets.height,
          createdAt: assets.createdAt,
          metadata: assets.metadata,
          campaignCount: sql<number>`(
            SELECT count(*)::int FROM ${campaigns}
            WHERE ${campaigns.assetId} = ${assets.id}
              AND ${campaigns.deletedAt} IS NULL
          )`,
        })
        .from(assets)
        .where(where)
        .orderBy(orderBy)
        .limit(limit)
        .offset(offset),
      tx.select({ count: sql<number>`count(*)::int` }).from(assets).where(where),
    ]);

    return { items: rows as AssetListItem[], total: counted[0]?.count ?? 0 };
  });
}

export async function getAsset(params: { organizationId: string; assetId: string }) {
  const rows = await withTenant({ organizationId: params.organizationId }, (tx) =>
    tx
      .select()
      .from(assets)
      .where(
        and(
          eq(assets.id, params.assetId),
          eq(assets.organizationId, params.organizationId),
          isNull(assets.deletedAt),
        ),
      )
      .limit(1),
  );

  const asset = rows[0];
  if (!asset) throw new AppError('not_found');
  return asset;
}

/**
 * Issues a presigned URL for an asset.
 *
 * The tenant check happens here, in `getAsset`, *before* a URL is minted. That
 * ordering is the whole control: once a presigned URL exists it is a bearer
 * credential, so it must never be produced for an asset the caller cannot see.
 */
export async function getAssetDownloadUrl(params: {
  organizationId: string;
  assetId: string;
  forDownload?: boolean;
}): Promise<string> {
  const asset = await getAsset(params);

  if (!asset.storageKey) {
    throw new AppError('not_found', {
      internalMessage: `Asset ${asset.id} has no storage key (status ${asset.status})`,
    });
  }

  const extension = asset.storageKey.split('.').pop() ?? 'bin';

  return signedDownloadUrl(asset.storageKey, {
    downloadFileName: params.forDownload ? `${asset.title}.${extension}` : undefined,
  });
}

export async function deleteAsset(params: {
  organizationId: string;
  userId: string;
  assetId: string;
  correlationId: string;
}): Promise<void> {
  const asset = await getAsset(params);

  // An asset attached to a campaign that has not gone to Meta yet is still
  // needed; deleting it would leave the campaign unsubmittable with no
  // explanation. Campaigns already submitted have their own copy on Meta.
  const attached = await withTenant({ organizationId: params.organizationId }, (tx) =>
    tx
      .select({ id: campaigns.id, status: campaigns.status })
      .from(campaigns)
      .where(
        and(
          eq(campaigns.assetId, params.assetId),
          eq(campaigns.organizationId, params.organizationId),
          isNull(campaigns.deletedAt),
        ),
      ),
  );

  const blocking = attached.filter(
    (campaign) => campaign.status === 'DRAFT' || campaign.status === 'READY',
  );
  if (blocking.length > 0) {
    throw new AppError('conflict', {
      internalMessage: `Asset ${params.assetId} is attached to ${blocking.length} unsubmitted campaign(s)`,
    });
  }

  await withTenant(
    { organizationId: params.organizationId, userId: params.userId },
    (tx) =>
      tx
        .update(assets)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(
          and(eq(assets.id, params.assetId), eq(assets.organizationId, params.organizationId)),
        ),
  );

  // The row is soft-deleted first so a storage failure cannot leave the asset
  // visible in the library.
  if (asset.storageKey) await deleteObject(asset.storageKey);

  await recordAudit({
    organizationId: params.organizationId,
    userId: params.userId,
    action: 'asset.deleted',
    resourceType: 'asset',
    resourceId: params.assetId,
    status: 'SUCCESS',
    correlationId: params.correlationId,
    metadata: { title: asset.title, kind: asset.kind },
  });
}

/** Total bytes stored by a tenant, for the dashboard and future billing. */
export async function getStorageUsage(organizationId: string): Promise<{
  totalBytes: number;
  imageCount: number;
  videoCount: number;
}> {
  return withTenant({ organizationId }, async (tx) => {
    const rows = await tx
      .select({
        totalBytes: sql<number>`COALESCE(sum(${assets.sizeBytes}), 0)::bigint`,
        imageCount: sql<number>`count(*) FILTER (WHERE ${assets.kind} = 'IMAGE')::int`,
        videoCount: sql<number>`count(*) FILTER (WHERE ${assets.kind} = 'VIDEO')::int`,
      })
      .from(assets)
      .where(and(eq(assets.organizationId, organizationId), isNull(assets.deletedAt)));

    const row = rows[0];
    return {
      totalBytes: Number(row?.totalBytes ?? 0),
      imageCount: row?.imageCount ?? 0,
      videoCount: row?.videoCount ?? 0,
    };
  });
}

/** Creates an in-app notification, stored as an i18n key plus parameters. */
async function notify(params: {
  organizationId: string;
  userId: string;
  kind: 'ASSET_READY' | 'ASSET_FAILED';
  messageKey: string;
  messageParams: Record<string, string | number>;
  href?: string;
}): Promise<void> {
  await withTenant({ organizationId: params.organizationId }, (tx) =>
    tx.insert(notifications).values({
      organizationId: params.organizationId,
      userId: params.userId,
      kind: params.kind,
      messageKey: params.messageKey,
      messageParams: params.messageParams,
      href: params.href ?? null,
    }),
  );
}
