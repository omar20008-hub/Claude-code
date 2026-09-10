'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Link, useRouter } from '@/i18n/routing';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageHeader,
  Progress,
  cn,
} from '@/components/ui/primitives';
import {
  Field,
  Select,
  Textarea,
} from '@/components/ui/form';
import { IconCreative, IconImage, IconVideo, IconChevron } from '@/components/ui/icons';
import { ErrorMessage } from '@/components/auth/error-message';
import { apiFetch, ApiError } from '@/components/auth/api-error';
import { formatRelativeTime } from '@/i18n/format';
import type { Locale } from '@/i18n/config';

interface RecentAsset {
  id: string;
  title: string;
  kind: 'IMAGE' | 'VIDEO';
  createdAt: string;
}

interface GenerateResponse {
  jobId?: string;
  assetId?: string;
  downgradedToImage: boolean;
  title?: string;
  caption?: string;
  promptUsed?: string;
  error?: { code: string; retryable: boolean };
}

export function CreativeStudio({
  configured,
  storageConfigured,
  videoSupported,
  recentAssets,
}: {
  configured: boolean;
  storageConfigured: boolean;
  videoSupported: boolean;
  recentAssets: RecentAsset[];
}) {
  const t = useTranslations('creative');
  const tAssets = useTranslations('assets');
  const tJobs = useTranslations('jobs.status');
  const locale = useLocale() as Locale;
  const router = useRouter();

  const [mediaType, setMediaType] = useState<'IMAGE' | 'VIDEO'>('IMAGE');
  const [prompt, setPrompt] = useState('');
  const [aspectRatio, setAspectRatio] = useState<'16:9' | '9:16'>('16:9');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<GenerateResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const disabled = !configured || !storageConfigured;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (disabled || pending || prompt.trim().length < 3) return;

    setError(null);
    setResult(null);
    setPending(true);

    try {
      const response = await apiFetch<GenerateResponse>('/api/v1/assets', {
        method: 'POST',
        headers: {
          // A retried request — flaky network, double-clicked button — returns
          // the original job rather than paying for a second generation.
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({ prompt, mediaType, aspectRatio }),
      });

      setResult(response);
      if (response.assetId) router.refresh();
      if (response.error) {
        setError(new ApiError({ code: response.error.code, reference: '' }, 200));
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : null);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <PageHeader title={t('title')} description={t('subtitle')} />

      {!configured ? (
        <Alert tone="warning" className="mb-4" title={t('title')}>
          <NotConfigured />
        </Alert>
      ) : null}

      {!storageConfigured ? (
        <Alert tone="warning" className="mb-4">
          {tAssets('storage.notConfigured')}
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-6">
          <Card>
            <CardHeader title={t('newGeneration')} />
            <CardBody>
              <form onSubmit={handleSubmit} className="space-y-4">
                <fieldset>
                  <legend className="mb-2 text-sm font-medium text-[var(--text-primary)]">
                    {t('form.mediaType')}
                  </legend>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <MediaOption
                      selected={mediaType === 'IMAGE'}
                      onSelect={() => setMediaType('IMAGE')}
                      icon={<IconImage className="size-5" />}
                      label={t('form.image')}
                      disabled={disabled}
                    />
                    <MediaOption
                      selected={mediaType === 'VIDEO'}
                      onSelect={() => setMediaType('VIDEO')}
                      icon={<IconVideo className="size-5" />}
                      label={t('form.video')}
                      // Not hidden: the user asked for a product that makes
                      // video, so the option is shown and explained rather than
                      // quietly missing.
                      disabled={disabled || !videoSupported}
                      note={!videoSupported ? t('video.unavailableTitle') : undefined}
                    />
                  </div>
                </fieldset>

                {!videoSupported && mediaType === 'VIDEO' ? (
                  <Alert tone="warning" title={t('video.unavailableTitle')}>
                    {t('video.unavailableBody')}
                  </Alert>
                ) : null}

                <Field
                  id="prompt"
                  label={t('form.prompt')}
                  hint={t('form.promptHint')}
                  required
                >
                  <Textarea
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    placeholder={t('form.promptPlaceholder')}
                    rows={4}
                    // The prompt may be in either language regardless of the UI.
                    dir="auto"
                    disabled={disabled}
                    maxLength={2000}
                    required
                  />
                </Field>

                <Field
                  id="aspectRatio"
                  label={t('form.aspectRatio')}
                  hint={t('form.aspectRatioHint')}
                >
                  <Select
                    value={aspectRatio}
                    onChange={(event) =>
                      setAspectRatio(event.target.value as '16:9' | '9:16')
                    }
                    disabled={disabled}
                  >
                    {/* Only the two ratios the workflow's URL builder handles. */}
                    <option value="16:9">{t('form.aspectRatios.16:9')}</option>
                    <option value="9:16">{t('form.aspectRatios.9:16')}</option>
                  </Select>
                </Field>

                <Button
                  type="submit"
                  size="lg"
                  loading={pending}
                  disabled={disabled || prompt.trim().length < 3}
                >
                  {pending ? t('form.submitting') : t('form.submit')}
                </Button>
              </form>
            </CardBody>
          </Card>

          {pending ? (
            <Card>
              <CardBody className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-[var(--text-primary)]">
                    {t('job.processing')}
                  </span>
                  <Badge tone="info" dot>
                    {tJobs('PROCESSING')}
                  </Badge>
                </div>
                {/* Indeterminate: the workflow reports no progress, so a
                    percentage would be invented. */}
                <Progress value={40} label={t('job.processing')} />
              </CardBody>
            </Card>
          ) : null}

          <ErrorMessage error={error} />

          {result && !result.error ? (
            <Card>
              <CardHeader
                title={t('result.title')}
                action={
                  result.assetId ? (
                    <Link href={`/assets/${result.assetId}`}>
                      <Button variant="secondary" size="sm" iconEnd={<IconChevron className="size-4" />}>
                        {t('job.viewAsset')}
                      </Button>
                    </Link>
                  ) : null
                }
              />
              <CardBody className="space-y-3">
                {result.downgradedToImage ? (
                  // Says plainly that a still was produced instead of a video.
                  <Alert tone="warning" title={t('video.unavailableTitle')}>
                    {t('video.unavailableBody')}
                  </Alert>
                ) : null}

                {result.title ? (
                  <p dir="auto" className="text-sm font-medium text-[var(--text-primary)]">
                    {result.title}
                  </p>
                ) : null}

                {result.caption ? (
                  <div>
                    <p className="text-xs text-[var(--text-muted)]">{t('result.caption')}</p>
                    <p dir="auto" className="mt-0.5 text-sm text-[var(--text-secondary)]">
                      {result.caption}
                    </p>
                  </div>
                ) : null}

                {result.promptUsed ? (
                  <div>
                    <p className="text-xs text-[var(--text-muted)]">{t('result.promptUsed')}</p>
                    {/* The generated prompt is always English; isolate it. */}
                    <p className="force-ltr mt-0.5 rounded-[var(--radius-control)] bg-[var(--surface-sunken)] p-2 font-mono text-xs text-[var(--text-secondary)]">
                      {result.promptUsed}
                    </p>
                  </div>
                ) : null}
              </CardBody>
            </Card>
          ) : null}
        </div>

        {/* --- Recent generations ---------------------------------------- */}
        <aside>
          <Card>
            <CardHeader
              title={t('history.title')}
              action={
                <Link
                  href="/assets"
                  className="text-sm text-[var(--text-brand)] hover:underline"
                >
                  {tAssets('title')}
                </Link>
              }
            />
            <CardBody className="p-3">
              {recentAssets.length === 0 ? (
                <EmptyState
                  icon={<IconCreative className="size-5" />}
                  title={t('history.empty.title')}
                  body={t('history.empty.body')}
                />
              ) : (
                <ul className="space-y-1">
                  {recentAssets.map((asset) => (
                    <li key={asset.id}>
                      <Link
                        href={`/assets/${asset.id}`}
                        className="flex items-center gap-2.5 rounded-[var(--radius-control)] px-2 py-2 hover:bg-[var(--surface-raised)]"
                      >
                        <span className="shrink-0 text-[var(--text-muted)]">
                          {asset.kind === 'IMAGE' ? (
                            <IconImage className="size-4" />
                          ) : (
                            <IconVideo className="size-4" />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span
                            dir="auto"
                            className="block truncate text-sm text-[var(--text-primary)]"
                          >
                            {asset.title}
                          </span>
                          <span className="block text-xs text-[var(--text-muted)]">
                            {formatRelativeTime(asset.createdAt, locale)}
                          </span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </aside>
      </div>
    </>
  );
}

function MediaOption({
  selected,
  onSelect,
  icon,
  label,
  disabled,
  note,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  note?: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        'flex items-center gap-3 rounded-[var(--radius-control)] border p-3 text-start transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-55',
        selected
          ? 'border-[var(--color-brand-600)] bg-[var(--color-brand-50)]'
          : 'border-[var(--border-strong)] hover:bg-[var(--surface-raised)]',
      )}
    >
      <span className={selected ? 'text-[var(--color-brand-700)]' : 'text-[var(--text-muted)]'}>
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-[var(--text-primary)]">{label}</span>
        {note ? (
          <span className="block text-xs text-[var(--status-warning-fg)]">{note}</span>
        ) : null}
      </span>
    </button>
  );
}

function NotConfigured() {
  const t = useTranslations('errors');
  return <>{t('integration_not_configured')}</>;
}
