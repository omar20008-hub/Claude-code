import { getTranslations } from 'next-intl/server';
import { requireSession } from '@/server/auth/session';
import {
  getActivityMetrics,
  getKnowledgeMetrics,
  getCreativeMetrics,
  getAdvertisingMetrics,
  getHealthStatus,
} from '@/server/services/analytics-service';
import {
  Card,
  CardBody,
  CardHeader,
  PageHeader,
  Badge,
  EmptyState,
  Alert,
} from '@/components/ui/primitives';
import { IconDashboard } from '@/components/ui/icons';
import { Link } from '@/i18n/routing';
import { formatBytes, formatDuration, formatNumber, formatRelativeTime } from '@/i18n/format';
import type { Locale } from '@/i18n/config';

export const dynamic = 'force-dynamic';

/**
 * Administrator dashboard (§13, §14).
 *
 * Every figure is read from rows this platform wrote. Where a number cannot be
 * known — Meta performance, the indexed document count — the tile renders an
 * explicit "not available" with the reason rather than a zero, because a zero
 * reads as "nothing happened" rather than "we cannot see this" (§52).
 */
export default async function DashboardPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale = rawLocale as Locale;
  const session = await requireSession();
  const t = await getTranslations('dashboard');
  const tHealth = await getTranslations('health');
  const tCampaigns = await getTranslations('campaigns');
  const tKnowledge = await getTranslations('knowledge');
  const tCreative = await getTranslations('creative');
  const tAgents = await getTranslations('agents');

  // Fetched concurrently: five sequential round trips would make the most
  // visited page in the product the slowest.
  const [activity, knowledge, creative, advertising, health] = await Promise.all([
    getActivityMetrics(session.organizationId),
    getKnowledgeMetrics(session.organizationId),
    getCreativeMetrics(session.organizationId),
    getAdvertisingMetrics(session.organizationId),
    getHealthStatus(session.organizationId),
  ]);

  const nf = (value: number) => formatNumber(value, locale);
  const hasActivity = activity.total > 0;

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('greeting', { name: session.name })}
      />

      {!hasActivity ? (
        <Card className="mb-6">
          <EmptyState
            icon={<IconDashboard className="size-6" />}
            title={t('empty.noActivity.title')}
            body={t('empty.noActivity.body')}
          />
        </Card>
      ) : null}

      {/* --- Overall activity ------------------------------------------- */}
      <section aria-labelledby="activity-heading" className="mb-8">
        <h2
          id="activity-heading"
          className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]"
        >
          {t('sections.activity')}
        </h2>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <Metric label={t('metrics.totalRequests')} value={nf(activity.total)} />
          <Metric label={t('metrics.requestsToday')} value={nf(activity.today)} />
          <Metric label={t('metrics.requestsThisWeek')} value={nf(activity.thisWeek)} />
          <Metric label={t('metrics.requestsThisMonth')} value={nf(activity.thisMonth)} />
          <Metric
            label={t('metrics.successfulRequests')}
            value={nf(activity.successful)}
            tone="success"
          />
          <Metric
            label={t('metrics.failedRequests')}
            value={nf(activity.failed)}
            tone={activity.failed > 0 ? 'danger' : undefined}
          />
          <Metric
            label={t('metrics.averageProcessingTime')}
            value={
              activity.averageProcessingMs === null
                ? '—'
                : formatDuration(activity.averageProcessingMs, locale)
            }
            unavailable={activity.averageProcessingMs === null}
          />
          <Metric
            label={t('metrics.successRate')}
            value={
              activity.total > 0
                ? `${Math.round((activity.successful / activity.total) * 100)}%`
                : '—'
            }
            unavailable={activity.total === 0}
          />
        </div>

        {activity.byAgent.length > 0 ? (
          <Card className="mt-4">
            <CardHeader title={t('metrics.requestsByAgent')} />
            <CardBody className="flex flex-wrap gap-3">
              {activity.byAgent.map((entry) => (
                <div
                  key={entry.agent}
                  className="flex min-w-40 flex-1 items-center justify-between gap-3 rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-3 py-2"
                >
                  <span className="text-sm text-[var(--text-secondary)]">
                    {tAgents(`${agentKey(entry.agent)}.shortTitle`)}
                  </span>
                  <span className="text-sm font-semibold tabular-nums text-[var(--text-primary)]">
                    {nf(entry.count)}
                  </span>
                </div>
              ))}
            </CardBody>
          </Card>
        ) : null}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* --- Knowledge ------------------------------------------------- */}
        <Card as="section">
          <CardHeader
            title={t('sections.knowledge')}
            action={
              <Link
                href="/knowledge"
                className="text-sm text-[var(--text-brand)] hover:underline"
              >
                {tKnowledge('title')}
              </Link>
            }
          />
          <CardBody className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Metric label={t('metrics.questionsAsked')} value={nf(knowledge.questionsAsked)} />
              <Metric
                label={t('metrics.questionsAnswered')}
                value={nf(knowledge.questionsAnswered)}
              />
            </div>

            {knowledge.source ? (
              <dl className="space-y-2 text-sm">
                <Row
                  label={t('metrics.knowledgeSourceStatus')}
                  value={
                    <span className="bidi-isolate">{knowledge.source.displayName}</span>
                  }
                />
                <Row
                  label={t('metrics.documentCount')}
                  value={
                    knowledge.source.documentCount === null ? (
                      // The workflow reports no count; say so rather than "0".
                      <span className="text-[var(--text-muted)]">
                        {tKnowledge('sourcePanel.documentsUnknown')}
                      </span>
                    ) : (
                      nf(knowledge.source.documentCount)
                    )
                  }
                />
                <Row
                  label={t('metrics.lastSync')}
                  value={
                    knowledge.source.lastSyncedAt
                      ? formatRelativeTime(knowledge.source.lastSyncedAt, locale)
                      : '—'
                  }
                />
                <Row
                  label={t('metrics.syncFailures')}
                  value={
                    <Badge tone={knowledge.source.recentFailures > 0 ? 'danger' : 'success'}>
                      {nf(knowledge.source.recentFailures)}
                    </Badge>
                  }
                />
              </dl>
            ) : (
              <Alert tone="info" title={tKnowledge('sourcePanel.notConnected.title')}>
                {tKnowledge('sourcePanel.notConnected.body')}
              </Alert>
            )}

            {knowledge.recentQuestions.length > 0 ? (
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                  {t('metrics.recentQuestions')}
                </h3>
                <ul className="space-y-1.5">
                  {knowledge.recentQuestions.map((question) => (
                    <li key={question.id} className="truncate text-sm text-[var(--text-secondary)]">
                      <Link
                        href={`/knowledge/${question.conversationId}`}
                        className="hover:text-[var(--text-primary)] hover:underline"
                      >
                        {question.content}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardBody>
        </Card>

        {/* --- Creative -------------------------------------------------- */}
        <Card as="section">
          <CardHeader
            title={t('sections.creative')}
            action={
              <Link href="/creative" className="text-sm text-[var(--text-brand)] hover:underline">
                {t('metrics.recentAssets')}
              </Link>
            }
          />
          <CardBody className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Metric label={t('metrics.imagesGenerated')} value={nf(creative.imagesGenerated)} />
              <Metric
                label={t('metrics.videosGenerated')}
                value={nf(creative.videosGenerated)}
                // The connected workflow cannot generate video at all.
                unavailable={creative.videosGenerated === 0 && Boolean(creative.videoUnavailableReasonKey)}
              />
              <Metric
                label={t('metrics.generationSuccessRate')}
                value={
                  creative.successRate === null
                    ? '—'
                    : `${Math.round(creative.successRate * 100)}%`
                }
                unavailable={creative.successRate === null}
              />
              <Metric
                label={t('metrics.storageUsed')}
                value={formatBytes(creative.storage.totalBytes, locale)}
              />
            </div>

            {creative.videoUnavailableReasonKey ? (
              <Alert tone="warning" title={tCreative('video.unavailableTitle')}>
                {tCreative('video.unavailableBody')}
              </Alert>
            ) : null}
          </CardBody>
        </Card>

        {/* --- Advertising ----------------------------------------------- */}
        <Card as="section">
          <CardHeader
            title={t('sections.advertising')}
            action={
              <Link href="/campaigns" className="text-sm text-[var(--text-brand)] hover:underline">
                {tCampaigns('title')}
              </Link>
            }
          />
          <CardBody className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Metric label={t('metrics.campaignsCreated')} value={nf(advertising.created)} />
              <Metric label={t('metrics.campaignsLaunched')} value={nf(advertising.submitted)} />
              <Metric label={t('metrics.draftCampaigns')} value={nf(advertising.draft)} />
              <Metric
                label={t('metrics.failedCampaigns')}
                value={nf(advertising.failed)}
                tone={advertising.failed > 0 ? 'danger' : undefined}
              />
            </div>

            {advertising.performance.available ? (
              <div className="grid grid-cols-2 gap-3">
                <Metric
                  label={t('metrics.impressions')}
                  value={nf(advertising.performance.impressions)}
                />
                <Metric label={t('metrics.clicks')} value={nf(advertising.performance.clicks)} />
              </div>
            ) : (
              // Explicit and specific: the workflow has no Insights node.
              <Alert tone="info" title={tCampaigns('performance.unavailableTitle')}>
                {tCampaigns('performance.unavailableBody')}
              </Alert>
            )}
          </CardBody>
        </Card>

        {/* --- Platform health -------------------------------------------- */}
        <Card as="section">
          <CardHeader title={t('sections.health')} />
          <CardBody className="space-y-3">
            <ul className="space-y-2">
              {health.checks.map((check) => (
                <li key={check.key} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-[var(--text-secondary)]">
                    {tHealth(`checks.${check.key}`)}
                  </span>
                  <Badge
                    tone={
                      check.status === 'healthy'
                        ? 'success'
                        : check.status === 'degraded'
                          ? 'warning'
                          : check.status === 'down'
                            ? 'danger'
                            : 'neutral'
                    }
                    dot
                  >
                    {tHealth(`status.${check.status}`)}
                  </Badge>
                </li>
              ))}
            </ul>

            <div className="grid grid-cols-2 gap-3 pt-1">
              <Metric
                label={t('metrics.recentErrors')}
                value={nf(health.recentErrorCount)}
                tone={health.recentErrorCount > 0 ? 'danger' : 'success'}
              />
              <Metric
                label={t('metrics.failedJobs')}
                value={nf(health.failedJobCount)}
                tone={health.failedJobCount > 0 ? 'warning' : 'success'}
              />
            </div>
          </CardBody>
        </Card>
      </div>
    </>
  );
}

function Metric({
  label,
  value,
  tone,
  unavailable,
}: {
  label: string;
  value: string;
  tone?: 'success' | 'danger' | 'warning';
  unavailable?: boolean;
}) {
  return (
    <div className="rounded-[var(--radius-control)] border border-[var(--border-subtle)] bg-[var(--surface-card)] p-3">
      <p className="text-xs text-[var(--text-muted)]">{label}</p>
      <p
        className={[
          'mt-1.5 text-xl font-semibold tabular-nums',
          unavailable
            ? 'text-[var(--text-muted)]'
            : tone === 'danger'
              ? 'text-[var(--status-danger-fg)]'
              : tone === 'warning'
                ? 'text-[var(--status-warning-fg)]'
                : 'text-[var(--text-primary)]',
        ].join(' ')}
      >
        {value}
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-[var(--text-secondary)]">{label}</dt>
      <dd className="font-medium text-[var(--text-primary)]">{value}</dd>
    </div>
  );
}

/** Maps an agent enum value onto its `agents.*` translation namespace. */
function agentKey(agent: string): 'knowledge' | 'creative' | 'advertising' {
  if (agent === 'KNOWLEDGE_AGENT') return 'knowledge';
  if (agent === 'CREATIVE_AGENT') return 'creative';
  return 'advertising';
}
