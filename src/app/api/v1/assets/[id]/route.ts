import { route, jsonResponse } from '@/server/api/handler';
import { getAsset, deleteAsset, getAssetDownloadUrl } from '@/server/services/asset-service';
import { AppError } from '@/lib/errors';

function assetId(params: Record<string, string>): string {
  const id = params.id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new AppError('not_found');
  return id;
}

export const GET = route({}, async ({ session, params, correlationId }) => {
  const id = assetId(params);

  const asset = await getAsset({ organizationId: session.organizationId, assetId: id });
  // Minted only after the tenant check inside getAsset — a presigned URL is a
  // bearer credential and must never be issued for an asset the caller cannot
  // already see.
  const url = await getAssetDownloadUrl({ organizationId: session.organizationId, assetId: id });

  return jsonResponse(
    {
      id: asset.id,
      kind: asset.kind,
      status: asset.status,
      title: asset.title,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      width: asset.width,
      height: asset.height,
      metadata: asset.metadata,
      createdAt: asset.createdAt,
      url,
      // The storage key is internal: it reveals the bucket layout and the
      // tenant id, neither of which the browser needs.
    },
    correlationId,
  );
});

export const DELETE = route({}, async ({ session, params, correlationId }) => {
  await deleteAsset({
    organizationId: session.organizationId,
    userId: session.userId,
    assetId: assetId(params),
    correlationId,
  });

  return jsonResponse({ ok: true }, correlationId);
});
