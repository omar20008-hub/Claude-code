import { getTranslations } from 'next-intl/server';
import { eq } from 'drizzle-orm';
import { requireSession } from '@/server/auth/session';
import { withTenant } from '@/server/tenancy/context';
import { integrations } from '@/server/db/schema';
import { allCapabilities } from '@/server/agents/gateway';
import { probeN8n } from '@/server/agents/n8n-client';
import { getKnowledgeSourceStatus } from '@/server/services/knowledge-service';
import { isN8nConfigured, isStorageConfigured, env } from '@/server/config/env';
import { META_CONFIG } from '@/server/agents/adapters/advertising';
import { KNOWLEDGE_REINDEX_INTERVAL_HOURS } from '@/server/agents/adapters/knowledge';
import {
  Alert,
  Badge,
  Card,
  CardBody,
  CardHeader,
  PageHeader,
} from '@/components/ui/primitives';
import { AccountSettings } from '@/components/settings/account-settings';
import { formatRelativeTime } from '@/i18n/format';
import type { Locale } from '@/i18n/config';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations('settings');
  return { title: t('title') };
}

/**
 * Settings (§17, §23).
 *
 * The integrations panel is deliberately honest about credential ownership:
 * Google and Meta credentials live inside the n8n workflows, not in this
 * application. It shows status and identifiers, and says where the secret
 * actually is — rather than implying this workspace holds an OAuth token it
 * has never seen.
 */
export default async function SettingsPage() {
  const session = await requireSession();
  const locale = session.locale as Locale;

  const t = await getTranslations('settings');
  const tIntegrations = await getTranslations('settings.integrations');
  const tKnowledge = await getTranslations('knowledge.sourcePanel');
  const tGeneric = await getTranslations();

  const [rows, knowledgeSource, n8nProbe] = await Promise.all([
    withTenant({ organizationId: session.organizationId }, (tx) =>
      tx.select().from(integrations).where(eq(integrations.organizationId, session.organizationId)),
    ),
    getKnowledgeSourceStatus(session.organizationId),
    isN8nConfigured() ? probeN8n().catch(() => null) : Promise.resolve(null),
  ]);

  const byKind = new Map(rows.map((row) => [row.kind, row]));
  const capabilities = allCapabilities();
  const metaCapability = capabilities.find((c) => c.agent === 'ADVERTISING_AGENT');

  const n8nStatus = !isN8nConfigured()
    ? 'NOT_CONFIGURED'
    : n8nProbe?.reachable
      ? 'CONNECTED'
      : 'ERROR';

  return (
    <>
      <PageHeader title={t('title')} description={t('subtitle')} />

      <div className="grid gap-6 lg:grid-cols-2">
        {/* --- Account -------------------------------------------------- */}
        <AccountSettings
          name={session.name}
          email={session.email}
          locale={locale}
          organizationName={session.organizationName}
          timezone={session.timezone}
          currency={session.currency}
        />

        {/* --- n8n ------------------------------------------------------ */}
        <Card>
          <CardHeader
            title={tIntegrations('n8n.title')}
            description={tIntegrations('n8n.description')}
            action={
              <Badge
                tone={
                  n8nStatus === 'CONNECTED'
                    ? 'success'
                    : n8nStatus === 'ERROR'
                      ? 'danger'
                      : 'neutral'
                }
                dot
              >
                {tIntegrations(`status.${n8nStatus}`)}
              </Badge>
            }
          />
          <CardBody className="space-y-3 text-sm">
            {!isN8nConfigured() ? (
              <Alert tone="warning">{tIntegrations('n8n.notConfigured')}</Alert>
            ) : null}

            <dl className="space-y-2">
              <Row
                label={tIntegrations('n8n.workflows')}
                value={
                  <span className="force-ltr block font-mono text-xs">
                    {[
                      env().N8N_KNOWLEDGE_WORKFLOW_ID,
                      env().N8N_CREATIVE_WORKFLOW_ID,
                      env().N8N_ADVERTISING_WORKFLOW_ID,
                    ]
                      .filter(Boolean)
                      .join(' · ') || '—'}
                  </span>
                }
              />
            </dl>
            {/* The base URL and webhook ids are NOT rendered: they are
                server-side configuration and must never reach the browser. */}
          </CardBody>
        </Card>

        {/* --- Google Drive --------------------------------------------- */}
        <Card>
          <CardHeader
            title={tIntegrations('googleDrive.title')}
            description={tIntegrations('googleDrive.description')}
            action={
              <Badge
                tone={
                  byKind.get('GOOGLE_DRIVE')?.status === 'CONNECTED' ? 'success' : 'neutral'
                }
                dot
              >
                {tIntegrations(
                  `status.${byKind.get('GOOGLE_DRIVE')?.status ?? 'NOT_CONFIGURED'}`,
                )}
              </Badge>
            }
          />
          <CardBody className="space-y-3 text-sm">
            <dl className="space-y-2">
              <Row
                label={tIntegrations('googleDrive.folder')}
                value={
                  <span className="bidi-isolate">{knowledgeSource?.displayName ?? '—'}</span>
                }
              />
              <Row
                label={tKnowledge('documents')}
                value={
                  knowledgeSource?.documentCount === null ||
                  knowledgeSource?.documentCount === undefined ? (
                    <span className="text-[var(--text-muted)]">
                      {tKnowledge('documentsUnknown')}
                    </span>
                  ) : (
                    String(knowledgeSource.documentCount)
                  )
                }
              />
              <Row
                label={tKnowledge('lastSync')}
                value={
                  knowledgeSource?.lastSyncedAt
                    ? formatRelativeTime(knowledgeSource.lastSyncedAt, locale)
                    : '—'
                }
              />
              <Row
                label={tIntegrations('googleDrive.supportedFormats')}
                value={tKnowledge('formats')}
              />
            </dl>

            <p className="text-xs text-[var(--text-muted)]">
              {tIntegrations('googleDrive.syncSchedule', {
                hours: KNOWLEDGE_REINDEX_INTERVAL_HOURS,
              })}
            </p>

            {/* Says outright that this app stores no Google credential. */}
            <Alert tone="info">{tIntegrations('googleDrive.credentialNotice')}</Alert>
          </CardBody>
        </Card>

        {/* --- Meta ----------------------------------------------------- */}
        <Card>
          <CardHeader
            title={tIntegrations('meta.title')}
            description={tIntegrations('meta.description')}
            action={
              <Badge
                tone={byKind.get('META_ADS')?.status === 'CONNECTED' ? 'success' : 'neutral'}
                dot
              >
                {tIntegrations(`status.${byKind.get('META_ADS')?.status ?? 'NOT_CONFIGURED'}`)}
              </Badge>
            }
          />
          <CardBody className="space-y-3 text-sm">
            <dl className="space-y-2">
              <Row
                label={tIntegrations('meta.adAccount')}
                value={
                  <span className="force-ltr font-mono text-xs">
                    act_{META_CONFIG.adAccountId}
                  </span>
                }
              />
              <Row
                label={tIntegrations('meta.page')}
                value={
                  <span className="force-ltr font-mono text-xs">{META_CONFIG.pageId}</span>
                }
              />
              <Row
                label={tIntegrations('meta.apiVersion')}
                value={
                  <span className="force-ltr font-mono text-xs">{META_CONFIG.apiVersion}</span>
                }
              />
            </dl>

            <Alert tone="info">{tIntegrations('meta.credentialNotice')}</Alert>

            {/* Every declared limitation, straight from the adapter. */}
            {metaCapability && metaCapability.unavailable.length > 0 ? (
              <ul className="space-y-1.5 text-xs text-[var(--text-secondary)]">
                {metaCapability.unavailable.map((gap) => (
                  <li
                    key={gap.capability}
                    className="rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-2.5 py-1.5"
                  >
                    {tGeneric(gap.reasonKey as 'advertising.pausedNotice.body')}
                  </li>
                ))}
              </ul>
            ) : null}
          </CardBody>
        </Card>

        {/* --- Storage --------------------------------------------------- */}
        <Card>
          <CardHeader
            title="Object storage"
            action={
              <Badge tone={isStorageConfigured() ? 'success' : 'neutral'} dot>
                {tIntegrations(
                  `status.${isStorageConfigured() ? 'CONNECTED' : 'NOT_CONFIGURED'}`,
                )}
              </Badge>
            }
          />
          <CardBody className="text-sm">
            {!isStorageConfigured() ? (
              <Alert tone="warning">{tGeneric('assets.storage.notConfigured')}</Alert>
            ) : (
              <p className="text-[var(--text-secondary)]">
                {tGeneric('settings.integrations.status.CONNECTED')}
              </p>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <dt className="text-[var(--text-muted)]">{label}</dt>
      <dd className="max-w-[60%] break-words text-end font-medium text-[var(--text-primary)]">
        {value}
      </dd>
    </div>
  );
}
