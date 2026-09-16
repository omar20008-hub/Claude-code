import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { requireSession } from '@/server/auth/session';
import {
  getCampaign,
  getCampaignPerformance,
  reviewCampaign,
} from '@/server/services/campaign-service';
import { getAsset } from '@/server/services/asset-service';
import { Link } from '@/i18n/routing';
import {
  Alert,
  Badge,
  Card,
  CardBody,
  CardHeader,
  PageHeader,
} from '@/components/ui/primitives';
import { formatCurrencyMinor, formatDate, formatRelativeTime } from '@/i18n/format';
import { isAppError } from '@/lib/errors';
import type { Locale } from '@/i18n/config';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations('campaigns.detail');
  return { title: t('title') };
}

export default async function CampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireSession();
  const locale = session.locale as Locale;

  const t = await getTranslations('campaigns');
  const tDetail = await getTranslations('campaigns.detail');
  const tWizard = await getTranslations('advertising.wizard');
  const tAdvertising = await getTranslations('advertising');

  try {
    const campaign = await getCampaign({
      organizationId: session.organizationId,
      campaignId: id,
    });

    const [asset, performance] = await Promise.all([
      campaign.assetId
        ? getAsset({ organizationId: session.organizationId, assetId: campaign.assetId }).catch(
            () => undefined,
          )
        : Promise.resolve(undefined),
      getCampaignPerformance({ organizationId: session.organizationId, campaignId: id }),
    ]);

    const review = reviewCampaign(campaign, asset);

    return (
      <>
        <PageHeader
          title={campaign.name}
          description={t(`statusHelp.${campaign.status}`)}
          actions={
            <Badge
              tone={
                campaign.status === 'ACTIVE'
                  ? 'success'
                  : campaign.status === 'FAILED'
                    ? 'danger'
                    : campaign.status === 'PAUSED'
                      ? 'warning'
                      : 'neutral'
              }
              dot
            >
              {t(`status.${campaign.status}`)}
            </Badge>
          }
        />

        {campaign.status === 'PAUSED' && campaign.metaCampaignId ? (
          <Alert tone="warning" className="mb-4" title={tAdvertising('pausedNotice.title')}>
            {tAdvertising('pausedNotice.body')}
          </Alert>
        ) : null}

        {campaign.status === 'FAILED' && campaign.lastErrorCode ? (
          <Alert tone="danger" className="mb-4" title={tDetail('error')}>
            {/* The user sees a localized code, never the upstream message. */}
            <LocalizedErrorCode code={campaign.lastErrorCode} />
          </Alert>
        ) : null}

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader title={tDetail('configuration')} />
            <CardBody>
              <dl className="space-y-3 text-sm">
                <Row label={tWizard('objective.title')} value={campaign.objective} ltr />
                <Row label={tWizard('brief.headline')} value={campaign.headline ?? '—'} />
                <Row label={tWizard('brief.primaryText')} value={campaign.primaryText ?? '—'} />
                <Row
                  label={tWizard('brief.destinationUrl')}
                  value={campaign.destinationUrl ?? '—'}
                  ltr
                />
                <Row label={tWizard('creative.placement')} value={campaign.placement ?? '—'} ltr />
                <Row
                  label={tWizard('budget.lifetimeBudget')}
                  value={
                    campaign.lifetimeBudgetMinor
                      ? formatCurrencyMinor(
                          campaign.lifetimeBudgetMinor,
                          campaign.currency,
                          locale,
                        )
                      : '—'
                  }
                />
                <Row
                  label={tWizard('schedule.title')}
                  value={
                    campaign.startDate && campaign.endDate
                      ? `${formatDate(campaign.startDate, locale)} – ${formatDate(campaign.endDate, locale)}`
                      : '—'
                  }
                  ltr
                />
                <Row
                  label={tWizard('audience.countries')}
                  value={campaign.countries.join(', ')}
                  ltr
                />
                <Row
                  label={tWizard('creative.title')}
                  value={
                    asset ? (
                      <Link
                        href={`/assets/${asset.id}`}
                        className="text-[var(--text-brand)] hover:underline"
                      >
                        {asset.title}
                      </Link>
                    ) : (
                      '—'
                    )
                  }
                />
              </dl>
            </CardBody>
          </Card>

          <div className="space-y-6">
            <Card>
              <CardHeader title={tDetail('metaObjects')} />
              <CardBody>
                <dl className="space-y-3 text-sm">
                  <Row
                    label={tDetail('adAccount')}
                    value={campaign.metaAdAccountId ? `act_${campaign.metaAdAccountId}` : '—'}
                    ltr
                  />
                  <Row label={tDetail('page')} value={campaign.metaPageId ?? '—'} ltr />
                  <Row label={tDetail('campaignId')} value={campaign.metaCampaignId ?? '—'} ltr />
                  <Row label={tDetail('adSetId')} value={campaign.metaAdSetId ?? '—'} ltr />
                  <Row label={tDetail('adId')} value={campaign.metaAdId ?? '—'} ltr />
                  <Row
                    label={tDetail('objectStatus')}
                    value={campaign.metaObjectStatus ?? '—'}
                    ltr
                  />
                </dl>
              </CardBody>
            </Card>

            <Card>
              <CardHeader title={tDetail('approval')} />
              <CardBody className="text-sm">
                {campaign.approvedAt ? (
                  <p className="text-[var(--text-secondary)]">
                    {tDetail('approvedAt', {
                      time: formatRelativeTime(campaign.approvedAt, locale),
                    })}
                  </p>
                ) : (
                  <p className="text-[var(--text-muted)]">{tDetail('notApproved')}</p>
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader title={tDetail('performance')} />
              <CardBody>
                {performance.available ? (
                  <dl className="grid grid-cols-2 gap-3 text-sm">
                    <Row label="Impressions" value={String(performance.impressions)} />
                    <Row label="Clicks" value={String(performance.clicks)} />
                  </dl>
                ) : (
                  /* The advertising workflow has no Insights node, so these
                     numbers are genuinely unobtainable. Saying so beats
                     rendering zeros that read as "no one saw this ad". */
                  <Alert tone="info" title={t('performance.unavailableTitle')}>
                    {t('performance.unavailableBody')}
                  </Alert>
                )}
              </CardBody>
            </Card>
          </div>
        </div>

        {review.warnings.length > 0 || review.blockers.length > 0 ? (
          <Card className="mt-6">
            <CardHeader title={tWizard('review.warnings')} />
            <CardBody>
              <ul className="space-y-1.5 text-sm">
                {[...review.blockers, ...review.warnings].map((issue, index) => (
                  <li key={index} className="text-[var(--text-secondary)]">
                    {tWizard(
                      `review.warningItems.${issue.key}` as 'review.warningItems.shortSchedule',
                      issue.params ?? {},
                    )}
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        ) : null}
      </>
    );
  } catch (error) {
    if (isAppError(error) && error.code === 'not_found') notFound();
    throw error;
  }
}

function Row({
  label,
  value,
  ltr,
}: {
  label: string;
  value: React.ReactNode;
  ltr?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <dt className="text-[var(--text-muted)]">{label}</dt>
      <dd
        dir={ltr ? 'ltr' : 'auto'}
        className={[
          'max-w-[60%] break-words text-end font-medium text-[var(--text-primary)]',
          ltr ? 'force-ltr font-mono text-xs' : '',
        ].join(' ')}
      >
        {value}
      </dd>
    </div>
  );
}

/** Renders a stored error code through the catalogue, never raw. */
async function LocalizedErrorCode({ code }: { code: string }) {
  const t = await getTranslations('errors');
  const known = new Set([
    'agent_failed', 'agent_timeout', 'agent_unavailable', 'validation_failed',
    'unsupported_media_type', 'integration_not_configured', 'internal_error',
  ]);
  return <>{known.has(code) ? t(code as 'agent_failed') : t('generic')}</>;
}
