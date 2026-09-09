import { getTranslations } from 'next-intl/server';
import { requireSession } from '@/server/auth/session';
import { listCampaigns } from '@/server/services/campaign-service';
import { Link } from '@/i18n/routing';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  TableWrapper,
  Td,
  Th,
  Alert,
} from '@/components/ui/primitives';
import { IconCampaigns } from '@/components/ui/icons';
import { formatCurrencyMinor, formatDate } from '@/i18n/format';
import type { Locale } from '@/i18n/config';
import type { Campaign } from '@/server/db/schema';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations('campaigns');
  return { title: t('title') };
}

const STATUS_TONE: Record<Campaign['status'], 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  DRAFT: 'neutral',
  READY: 'info',
  LAUNCHING: 'info',
  ACTIVE: 'success',
  // Paused is the *expected* end state of a successful submission here, so it
  // reads as a warning (attention needed in Ads Manager), not a failure.
  PAUSED: 'warning',
  COMPLETED: 'neutral',
  FAILED: 'danger',
};

export default async function CampaignsPage() {
  const session = await requireSession();
  const t = await getTranslations('campaigns');
  const tAdvertising = await getTranslations('advertising');
  const locale = session.locale as Locale;

  const { items, total } = await listCampaigns({
    organizationId: session.organizationId,
    limit: 50,
  });

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('subtitle')}
        actions={
          <Link href="/advertising">
            <Button>{tAdvertising('newCampaign')}</Button>
          </Link>
        }
      />

      {total > 0 ? (
        <Alert tone="info" className="mb-4" title={tAdvertising('pausedNotice.title')}>
          {tAdvertising('pausedNotice.body')}
        </Alert>
      ) : null}

      {items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<IconCampaigns className="size-6" />}
            title={t('empty.title')}
            body={t('empty.body')}
            action={
              <Link href="/advertising">
                <Button>{t('empty.action')}</Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <Card>
          <TableWrapper label={t('title')}>
            <thead>
              <tr>
                <Th>{t('columns.name')}</Th>
                <Th>{t('columns.status')}</Th>
                <Th>{t('columns.budget')}</Th>
                <Th>{t('columns.schedule')}</Th>
                <Th>{t('columns.creative')}</Th>
              </tr>
            </thead>
            <tbody>
              {items.map(({ campaign, assetTitle }) => (
                <tr key={campaign.id} className="hover:bg-[var(--surface-raised)]">
                  <Td>
                    <Link
                      href={`/campaigns/${campaign.id}`}
                      className="font-medium text-[var(--text-brand)] hover:underline"
                      dir="auto"
                    >
                      {campaign.name}
                    </Link>
                    {campaign.metaCampaignId ? (
                      // A Meta ID is a Latin numeric run; isolate it so it does
                      // not reorder inside an Arabic table cell.
                      <span className="force-ltr mt-0.5 block font-mono text-xs text-[var(--text-muted)]">
                        {campaign.metaCampaignId}
                      </span>
                    ) : null}
                  </Td>
                  <Td>
                    <Badge tone={STATUS_TONE[campaign.status]} dot>
                      {t(`status.${campaign.status}`)}
                    </Badge>
                  </Td>
                  <Td className="tabular-nums">
                    {campaign.lifetimeBudgetMinor
                      ? formatCurrencyMinor(
                          campaign.lifetimeBudgetMinor,
                          campaign.currency,
                          locale,
                        )
                      : '—'}
                  </Td>
                  <Td className="text-xs">
                    {campaign.startDate && campaign.endDate ? (
                      <span className="force-ltr inline-block">
                        {formatDate(campaign.startDate, locale)} –{' '}
                        {formatDate(campaign.endDate, locale)}
                      </span>
                    ) : (
                      '—'
                    )}
                  </Td>
                  <Td dir="auto" className="max-w-48 truncate text-xs">
                    {assetTitle ?? '—'}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrapper>
        </Card>
      )}
    </>
  );
}
