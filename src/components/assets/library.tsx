'use client';

import { useState, useTransition } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Link, useRouter } from '@/i18n/routing';
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  PageHeader,
  Skeleton,
  cn,
} from '@/components/ui/primitives';
import {
  Input,
  Select,
} from '@/components/ui/form';
import { IconImage, IconVideo, IconSearch, IconChevron } from '@/components/ui/icons';
import { formatBytes, formatRelativeTime, formatNumber } from '@/i18n/format';
import type { Locale } from '@/i18n/config';

interface AssetItem {
  id: string;
  kind: 'IMAGE' | 'VIDEO';
  title: string;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  createdAt: string;
  campaignCount: number;
  downgradedFrom: string | null;
}

export function AssetLibrary({
  items,
  total,
  page,
  pageSize,
  filters,
  storage,
}: {
  items: AssetItem[];
  total: number;
  page: number;
  pageSize: number;
  filters: { kind?: 'IMAGE' | 'VIDEO'; search: string; sort: string };
  storage: { totalBytes: number; imageCount: number; videoCount: number };
}) {
  const t = useTranslations('assets');
  const tCommon = useTranslations('common');
  const tCreative = useTranslations('creative');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [search, setSearch] = useState(filters.search);

  /**
   * Filters are pushed into the URL rather than held in state, so a filtered
   * view can be bookmarked, shared and restored by the back button.
   */
  function applyFilters(next: Partial<{ kind: string; search: string; sort: string; page: string }>) {
    const params = new URLSearchParams();
    const merged = {
      kind: filters.kind ?? '',
      search: filters.search,
      sort: filters.sort,
      page: '1',
      ...next,
    };

    for (const [key, value] of Object.entries(merged)) {
      if (value && value !== '1') params.set(key, value);
      if (key === 'page' && value && value !== '1') params.set(key, value);
    }

    startTransition(() => {
      router.replace(`/assets${params.toString() ? `?${params}` : ''}`);
    });
  }

  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  const hasFilters = Boolean(filters.kind || filters.search);

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('subtitle')}
        actions={
          <Link href="/creative">
            <Button variant="secondary">{tCreative('title')}</Button>
          </Link>
        }
      />

      {/* --- Storage summary ------------------------------------------- */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Summary label={t('kinds.IMAGE')} value={formatNumber(storage.imageCount, locale)} />
        <Summary label={t('kinds.VIDEO')} value={formatNumber(storage.videoCount, locale)} />
        <Summary
          label={tCommon('labels.size')}
          value={formatBytes(storage.totalBytes, locale)}
        />
      </div>

      {/* --- Filters ---------------------------------------------------- */}
      <Card className="mb-4">
        <CardBody className="flex flex-wrap items-end gap-3">
          <div className="min-w-48 flex-1">
            <label htmlFor="asset-search" className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]">
              {t('filters.search')}
            </label>
            <div className="relative">
              <IconSearch className="pointer-events-none absolute inset-block-0 start-2.5 my-auto size-4 text-[var(--text-muted)]" />
              <Input
                id="asset-search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') applyFilters({ search });
                }}
                onBlur={() => {
                  if (search !== filters.search) applyFilters({ search });
                }}
                className="ps-9"
              />
            </div>
          </div>

          <div className="w-40">
            <label htmlFor="asset-kind" className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]">
              {t('filters.kind')}
            </label>
            <Select
              id="asset-kind"
              value={filters.kind ?? ''}
              onChange={(event) => applyFilters({ kind: event.target.value })}
            >
              <option value="">{t('kinds.all')}</option>
              <option value="IMAGE">{t('kinds.IMAGE')}</option>
              <option value="VIDEO">{t('kinds.VIDEO')}</option>
            </Select>
          </div>

          <div className="w-44">
            <label htmlFor="asset-sort" className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]">
              {t('filters.sortBy')}
            </label>
            <Select
              id="asset-sort"
              value={filters.sort}
              onChange={(event) => applyFilters({ sort: event.target.value })}
            >
              <option value="newest">{t('filters.sort.newest')}</option>
              <option value="oldest">{t('filters.sort.oldest')}</option>
              <option value="largest">{t('filters.sort.largest')}</option>
              <option value="titleAsc">{t('filters.sort.titleAsc')}</option>
            </Select>
          </div>

          {hasFilters ? (
            <Button
              variant="ghost"
              onClick={() => {
                setSearch('');
                applyFilters({ kind: '', search: '', sort: 'newest' });
              }}
            >
              {tCommon('actions.clearFilters')}
            </Button>
          ) : null}
        </CardBody>
      </Card>

      {/* --- Grid -------------------------------------------------------- */}
      {isPending ? (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <Skeleton key={index} className="aspect-video" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<IconImage className="size-6" />}
            title={hasFilters ? t('noResults.title') : t('empty.title')}
            body={hasFilters ? t('noResults.body') : t('empty.body')}
            action={
              hasFilters ? null : (
                <Link href="/creative">
                  <Button>{t('empty.action')}</Button>
                </Link>
              )
            }
          />
        </Card>
      ) : (
        <ul className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
          {items.map((asset) => (
            <Card as="li" key={asset.id} className="overflow-hidden">
              <Link href={`/assets/${asset.id}`} className="block">
                {/* The preview loads through the API, which mints a presigned
                    URL only after checking the asset belongs to this tenant. */}
                <div className="relative aspect-video bg-[var(--surface-sunken)]">
                  {asset.kind === 'IMAGE' ? (
                    // eslint-disable-next-line @next/next/no-img-element -- the
                    // source is a short-lived presigned URL on an arbitrary S3
                    // host, which next/image cannot pre-optimise.
                    <img
                      src={`/api/v1/assets/${asset.id}/content`}
                      alt={asset.title}
                      loading="lazy"
                      className="size-full object-cover"
                    />
                  ) : (
                    <div className="grid size-full place-items-center text-[var(--text-muted)]">
                      <IconVideo className="size-8" />
                    </div>
                  )}
                </div>

                <CardBody className="space-y-1.5 p-3">
                  <p dir="auto" className="line-clamp-2 text-sm font-medium text-[var(--text-primary)]">
                    {asset.title}
                  </p>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone="neutral">{t(`kinds.${asset.kind}`)}</Badge>
                    {asset.downgradedFrom ? (
                      // The user asked for a video and got a key frame; the
                      // library says so months later, not just at generation.
                      <Badge tone="warning">{tCreative('video.unavailableTitle')}</Badge>
                    ) : null}
                    {asset.campaignCount > 0 ? (
                      <Badge tone="info">
                        {t('card.usedInCampaigns', { count: asset.campaignCount })}
                      </Badge>
                    ) : null}
                  </div>

                  <p className="text-xs text-[var(--text-muted)]">
                    {formatRelativeTime(asset.createdAt, locale)}
                    {asset.sizeBytes ? ` · ${formatBytes(asset.sizeBytes, locale)}` : ''}
                  </p>
                </CardBody>
              </Link>
            </Card>
          ))}
        </ul>
      )}

      {/* --- Pagination -------------------------------------------------- */}
      {total > pageSize ? (
        <nav
          className="mt-6 flex items-center justify-between gap-3"
          aria-label={tCommon('pagination.page', { page })}
        >
          <p className="text-sm text-[var(--text-secondary)]">
            {tCommon('pagination.showing', { from, to, total })}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={page <= 1}
              onClick={() => applyFilters({ page: String(page - 1) })}
              aria-label={tCommon('pagination.previousPage')}
            >
              {/* The chevron mirrors with direction, so "previous" always
                  points back the way the reader came. */}
              <IconChevron className="size-4 rotate-180" />
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={page >= lastPage}
              onClick={() => applyFilters({ page: String(page + 1) })}
              aria-label={tCommon('pagination.nextPage')}
            >
              <IconChevron className="size-4" />
            </Button>
          </div>
        </nav>
      ) : null}
    </>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <Card className={cn('p-3')}>
      <p className="text-xs text-[var(--text-muted)]">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-[var(--text-primary)]">{value}</p>
    </Card>
  );
}
