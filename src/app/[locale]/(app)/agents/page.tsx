import { getTranslations } from 'next-intl/server';
import { requireSession } from '@/server/auth/session';
import { allCapabilities } from '@/server/agents/gateway';
import { Link } from '@/i18n/routing';
import { Badge, Card, CardBody, PageHeader, Alert } from '@/components/ui/primitives';
import { IconKnowledge, IconCreative, IconAdvertising, IconChevron } from '@/components/ui/icons';
import type { AgentName } from '@/server/agents/contracts';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations('agents');
  return { title: t('title') };
}

const AGENT_VIEW: Record<
  AgentName,
  { key: 'knowledge' | 'creative' | 'advertising'; href: string; icon: React.ReactNode }
> = {
  KNOWLEDGE_AGENT: { key: 'knowledge', href: '/knowledge', icon: <IconKnowledge /> },
  CREATIVE_AGENT: { key: 'creative', href: '/creative', icon: <IconCreative /> },
  ADVERTISING_AGENT: { key: 'advertising', href: '/advertising', icon: <IconAdvertising /> },
};

/**
 * The three AI employees (§15).
 *
 * Availability and every "not available" note come from the adapters'
 * `capabilities()`, not from copy written here. That is what keeps the product's
 * claims tied to what the connected workflows actually do: when video
 * generation is off in n8n, this page says so, because the adapter says so.
 */
export default async function AgentsPage() {
  await requireSession();
  const t = await getTranslations('agents');
  const capabilities = allCapabilities();

  return (
    <>
      <PageHeader title={t('title')} description={t('subtitle')} />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {capabilities.map((capability) => {
          const view = AGENT_VIEW[capability.agent];

          return (
            <Card key={capability.agent} as="article" className="flex flex-col">
              <CardBody className="flex flex-1 flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="grid size-11 shrink-0 place-items-center rounded-[var(--radius-control)] bg-[var(--color-brand-50)] text-[var(--color-brand-700)] [&>svg]:size-5.5">
                    {view.icon}
                  </div>
                  <Badge tone={capability.configured ? 'success' : 'neutral'} dot>
                    {capability.configured ? t('available') : t('unavailable')}
                  </Badge>
                </div>

                <div>
                  <h2 className="text-base font-semibold text-[var(--text-primary)]">
                    {t(`${view.key}.title`)}
                  </h2>
                  <p className="mt-1 text-sm leading-relaxed text-[var(--text-secondary)]">
                    {t(`${view.key}.description`)}
                  </p>
                  <p className="mt-2 text-xs text-[var(--text-muted)]">
                    {t(`${view.key}.capability`)}
                  </p>
                </div>

                {/* Declared limitations, straight from the adapter. */}
                {capability.unavailable.length > 0 ? (
                  <ul className="space-y-1.5">
                    {capability.unavailable.slice(0, 2).map((gap) => (
                      <li
                        key={gap.capability}
                        className="rounded-[var(--radius-control)] bg-[var(--status-warning-bg)] px-2.5 py-1.5 text-xs text-[var(--status-warning-fg)]"
                      >
                        <CapabilityNote reasonKey={gap.reasonKey} />
                      </li>
                    ))}
                  </ul>
                ) : null}

                <div className="mt-auto pt-2">
                  {capability.configured ? (
                    <Link
                      href={view.href}
                      className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--text-brand)] hover:underline"
                    >
                      {t('openAgent', { agent: t(`${view.key}.shortTitle`) })}
                      {/* data-flip-rtl mirrors the chevron so "forward" points
                          the way the reader is going. */}
                      <IconChevron className="size-4" />
                    </Link>
                  ) : (
                    <Alert tone="warning">
                      <NotConfiguredNote />
                    </Alert>
                  )}
                </div>
              </CardBody>
            </Card>
          );
        })}
      </div>
    </>
  );
}

/** Renders an adapter's `reasonKey` through the catalogue. */
async function CapabilityNote({ reasonKey }: { reasonKey: string }) {
  const t = await getTranslations();
  // Keys come from a closed set defined in the adapters, never from user input.
  return <>{t(reasonKey as Parameters<typeof t>[0])}</>;
}

async function NotConfiguredNote() {
  const t = await getTranslations('errors');
  return <>{t('integration_not_configured')}</>;
}
