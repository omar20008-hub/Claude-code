import { getTranslations } from 'next-intl/server';
import { requireSession } from '@/server/auth/session';
import { queryAuditLogs } from '@/server/services/audit';
import {
  Badge,
  Card,
  EmptyState,
  PageHeader,
  TableWrapper,
  Td,
  Th,
} from '@/components/ui/primitives';
import { IconActivity } from '@/components/ui/icons';
import { formatRelativeTime } from '@/i18n/format';
import type { Locale } from '@/i18n/config';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations('activity');
  return { title: t('title') };
}

/**
 * Audit trail (§35).
 *
 * Actions are stored as stable keys (`campaign.launched`), never as prose, so
 * an event recorded while the actor was using Arabic renders in English for an
 * English reader — and vice versa. That is only possible because nothing
 * human-readable was frozen into the row at write time.
 */
export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requireSession();
  const query = await searchParams;
  const locale = session.locale as Locale;

  const t = await getTranslations('activity');
  const tCommon = await getTranslations('common');

  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const pageSize = 50;

  const { entries, total } = await queryAuditLogs({
    organizationId: session.organizationId,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  // Only render a label for an action the catalogue knows; an unrecognised one
  // falls back to the raw key rather than crashing the page.
  const KNOWN_ACTIONS = new Set([
    'auth.login', 'auth.login_failed', 'auth.logout', 'auth.register',
    'auth.email_verified', 'auth.password_reset_requested', 'auth.password_reset',
    'auth.sessions_revoked', 'agent.invoked', 'agent.failed', 'knowledge.query',
    'knowledge.sync', 'conversation.created', 'conversation.deleted',
    'asset.generated', 'asset.deleted', 'campaign.created', 'campaign.updated',
    'campaign.approved', 'campaign.launched', 'campaign.launch_failed',
    'campaign.deleted', 'integration.connected', 'integration.disconnected',
    'settings.updated', 'webhook.rejected',
  ]);

  return (
    <>
      <PageHeader title={t('title')} description={t('subtitle')} />

      {entries.length === 0 ? (
        <Card>
          <EmptyState
            icon={<IconActivity className="size-6" />}
            title={t('empty.title')}
            body={t('empty.body')}
          />
        </Card>
      ) : (
        <Card>
          <TableWrapper label={t('title')}>
            <thead>
              <tr>
                <Th>{tCommon('labels.action')}</Th>
                <Th>{tCommon('labels.user')}</Th>
                <Th>{t('filters.resource')}</Th>
                <Th>{t('filters.status')}</Th>
                <Th>{tCommon('labels.createdAt')}</Th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <Td className="font-medium">
                    {KNOWN_ACTIONS.has(entry.action)
                      ? t(`actions.${entry.action}` as 'actions.auth.login')
                      : entry.action}
                  </Td>
                  <Td className="text-xs">
                    {entry.actorEmail ? (
                      // An email address is Latin text inside possibly-Arabic
                      // UI; isolate it so it cannot reorder.
                      <span className="force-ltr inline-block">{entry.actorEmail}</span>
                    ) : (
                      <span className="text-[var(--text-muted)]">{t('systemActor')}</span>
                    )}
                  </Td>
                  <Td className="text-xs text-[var(--text-secondary)]">
                    {entry.resourceType}
                  </Td>
                  <Td>
                    <Badge tone={entry.status === 'SUCCESS' ? 'success' : 'danger'}>
                      {t(`outcome.${entry.status === 'SUCCESS' ? 'SUCCESS' : 'FAILURE'}`)}
                    </Badge>
                  </Td>
                  <Td className="whitespace-nowrap text-xs text-[var(--text-muted)]">
                    {formatRelativeTime(entry.createdAt, locale)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrapper>
        </Card>
      )}

      {total > pageSize ? (
        <p className="mt-4 text-sm text-[var(--text-secondary)]">
          {tCommon('pagination.showing', {
            from: (page - 1) * pageSize + 1,
            to: Math.min(page * pageSize, total),
            total,
          })}
        </p>
      ) : null}
    </>
  );
}
