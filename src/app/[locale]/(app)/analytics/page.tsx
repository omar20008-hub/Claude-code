import { getTranslations } from 'next-intl/server';
import { requireSession } from '@/server/auth/session';
import {
  getActivityMetrics,
  getCreativeMetrics,
  getAdvertisingMetrics,
  getRequestTimeSeries,
  unavailableMetricKeys,
} from '@/server/services/analytics-service';
import {
  Alert,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageHeader,
} from '@/components/ui/primitives';
import { IconAnalytics } from '@/components/ui/icons';
import { RequestsChart } from '@/components/analytics/requests-chart';
import { formatBytes, formatDuration, formatNumber } from '@/i18n/format';
import type { Locale } from '@/i18n/config';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations('analytics');
  return { title: t('title') };
}

/**
 * Analytics (§36).
 *
 * Only metrics the connected integrations actually supply are charted. The
 * rest are named explicitly in a notice, so a reader knows the difference
 * between "this number is zero" and "we cannot see this number".
 */
export default async function AnalyticsPage() {
  const session = await requireSession();
  const locale = session.locale as Locale;

  const t = await getTranslations('analytics');
  const tDashboard = await getTranslations('dashboard');
  const tGeneric = await getTranslations();

  const [activity, creative, advertising, series] = await Promise.all([
    getActivityMetrics(session.organizationId),
    getCreativeMetrics(session.organizationId),
    getAdvertisingMetrics(session.organizationId),
    getRequestTimeSeries(session.organizationId),
  ]);

  const unavailable = unavailableMetricKeys();
  const nf = (value: number) => formatNumber(value, locale);
  const hasData = activity.total > 0;

  return (
    <>
      <PageHeader title={t('title')} description={t('subtitle')} />

      {unavailable.length > 0 ? (
        <Alert tone="info" className="mb-6" title={t('unavailableMetrics.title')}>
          {t('unavailableMetrics.body', {
            metrics: unavailable
              .map((key) => tGeneric(key as 'dashboard.metrics.impressions'))
              .join('، '),
          })}
        </Alert>
      ) : null}

      {!hasData ? (
        <Card>
          <EmptyState
            icon={<IconAnalytics className="size-6" />}
            title={tDashboard('empty.noMetrics.title')}
            body={tDashboard('empty.noMetrics.body')}
          />
        </Card>
      ) : (
        <div className="space-y-6">
          <Card>
            <CardHeader title={t('charts.requestsOverTime')} />
            <CardBody>
              <RequestsChart series={series} locale={locale} />
            </CardBody>
          </Card>

          <div className="grid gap-6 lg:grid-cols-3">
            <Card>
              <CardHeader title={t('sections.usage')} />
              <CardBody>
                <dl className="space-y-2.5 text-sm">
                  <Row label={tDashboard('metrics.totalRequests')} value={nf(activity.total)} />
                  <Row
                    label={tDashboard('metrics.successfulRequests')}
                    value={nf(activity.successful)}
                  />
                  <Row
                    label={tDashboard('metrics.failedRequests')}
                    value={nf(activity.failed)}
                  />
                  <Row
                    label={tDashboard('metrics.averageProcessingTime')}
                    value={
                      activity.averageProcessingMs === null
                        ? '—'
                        : formatDuration(activity.averageProcessingMs, locale)
                    }
                  />
                </dl>
              </CardBody>
            </Card>

            <Card>
              <CardHeader title={t('sections.creative')} />
              <CardBody>
                <dl className="space-y-2.5 text-sm">
                  <Row
                    label={tDashboard('metrics.imagesGenerated')}
                    value={nf(creative.imagesGenerated)}
                  />
                  <Row
                    label={tDashboard('metrics.videosGenerated')}
                    value={nf(creative.videosGenerated)}
                  />
                  <Row
                    label={tDashboard('metrics.generationSuccessRate')}
                    value={
                      creative.successRate === null
                        ? '—'
                        : `${Math.round(creative.successRate * 100)}%`
                    }
                  />
                  <Row
                    label={tDashboard('metrics.storageUsed')}
                    value={formatBytes(creative.storage.totalBytes, locale)}
                  />
                </dl>
              </CardBody>
            </Card>

            <Card>
              <CardHeader title={t('sections.advertising')} />
              <CardBody>
                <dl className="space-y-2.5 text-sm">
                  <Row
                    label={tDashboard('metrics.campaignsCreated')}
                    value={nf(advertising.created)}
                  />
                  <Row
                    label={tDashboard('metrics.campaignsLaunched')}
                    value={nf(advertising.submitted)}
                  />
                  <Row
                    label={tDashboard('metrics.failedCampaigns')}
                    value={nf(advertising.failed)}
                  />
                </dl>

                {!advertising.performance.available ? (
                  <p className="mt-3 text-xs text-[var(--text-muted)]">
                    {tGeneric('campaigns.performance.unavailableTitle')}
                  </p>
                ) : null}
              </CardBody>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-[var(--text-secondary)]">{label}</dt>
      <dd className="font-semibold tabular-nums text-[var(--text-primary)]">{value}</dd>
    </div>
  );
}
