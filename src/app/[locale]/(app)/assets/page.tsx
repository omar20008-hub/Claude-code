import { getTranslations } from 'next-intl/server';
import { requireSession } from '@/server/auth/session';
import { listAssets, getStorageUsage } from '@/server/services/asset-service';
import { AssetLibrary } from '@/components/assets/library';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations('assets');
  return { title: t('title') };
}

/**
 * Asset library (§19).
 *
 * Filters live in the URL so a filtered view is linkable and survives a reload,
 * and paging happens in the database — the browser never receives more than one
 * page of rows (§46).
 */
export default async function AssetsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requireSession();
  const query = await searchParams;

  const kind = query.kind === 'IMAGE' || query.kind === 'VIDEO' ? query.kind : undefined;
  const sort =
    query.sort === 'oldest' || query.sort === 'largest' || query.sort === 'titleAsc'
      ? query.sort
      : 'newest';
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const pageSize = 24;

  const [result, storage] = await Promise.all([
    listAssets({
      organizationId: session.organizationId,
      kind,
      search: query.search,
      sort,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    }),
    getStorageUsage(session.organizationId),
  ]);

  return (
    <AssetLibrary
      items={result.items.map((asset) => ({
        id: asset.id,
        kind: asset.kind,
        title: asset.title,
        sizeBytes: asset.sizeBytes,
        width: asset.width,
        height: asset.height,
        createdAt: asset.createdAt.toISOString(),
        campaignCount: asset.campaignCount,
        downgradedFrom:
          typeof asset.metadata.downgradedFrom === 'string'
            ? asset.metadata.downgradedFrom
            : null,
      }))}
      total={result.total}
      page={page}
      pageSize={pageSize}
      filters={{ kind, search: query.search ?? '', sort }}
      storage={storage}
    />
  );
}
