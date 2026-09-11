import { NextResponse } from 'next/server';
import { route } from '@/server/api/handler';
import { getAssetDownloadUrl } from '@/server/services/asset-service';
import { AppError } from '@/lib/errors';

/**
 * Redirects to a short-lived presigned URL for an asset's bytes.
 *
 * A redirect rather than a proxy, deliberately: streaming every image through
 * the Node process would put megabytes of media on the app's event loop and
 * make the object store's CDN pointless. The redirect keeps the authorization
 * decision on our side and the bytes on the storage side.
 *
 * The tenant check happens inside `getAssetDownloadUrl` BEFORE any URL is
 * minted. A presigned URL is a bearer credential: producing one for an asset
 * the caller cannot see would leak it regardless of what this route returns.
 */
export const GET = route({}, async ({ session, params, request }) => {
  const id = params.id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new AppError('not_found');

  const forDownload = new URL(request.url).searchParams.get('download') === '1';

  const url = await getAssetDownloadUrl({
    organizationId: session.organizationId,
    assetId: id,
    forDownload,
  });

  return NextResponse.redirect(url, {
    status: 302,
    headers: {
      // Never cached by a shared proxy: the URL behind it is both
      // tenant-specific and time-limited.
      'Cache-Control': 'private, no-store',
    },
  });
});
