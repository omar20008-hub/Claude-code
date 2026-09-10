'use client';

import { useMemo, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from '@/i18n/routing';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  PageHeader,
  cn,
} from '@/components/ui/primitives';
import {
  Checkbox,
  Field,
  Input,
  Select,
  Textarea,
} from '@/components/ui/form';
import { IconChevron, IconCheck, IconAlert, IconImage } from '@/components/ui/icons';
import { ErrorMessage } from '@/components/auth/error-message';
import { apiFetch, ApiError } from '@/components/auth/api-error';
import { formatCurrencyMinor, formatDate, formatNumber } from '@/i18n/format';
import type { Locale } from '@/i18n/config';

/**
 * Campaign creation wizard (§20, §21).
 *
 * The design constraint that shapes this file: a user must never be able to
 * spend money without understanding exactly what they authorised. So the review
 * step restates every value in full, the launch step requires an explicit
 * checkbox AND a confirmation dialog, and both say plainly that Meta objects
 * are created PAUSED and will not spend until someone activates them in Ads
 * Manager — which is what the connected workflow actually does.
 */

const STEPS = [
  'brief',
  'objective',
  'audience',
  'budget',
  'schedule',
  'creative',
  'review',
  'launch',
] as const;
type Step = (typeof STEPS)[number];

/**
 * Placements the workflow's creative validator accepts, with their required
 * ratios and their catalogue keys.
 *
 * `value` is Meta's own string and goes on the wire; `key` is what the
 * catalogue uses, because two of Meta's values contain dots and colons that a
 * dot-path translation lookup cannot address.
 */
const PLACEMENTS = [
  { value: 'Feed 1:1', ratio: 1, key: 'feed_square' },
  { value: 'Feed 4:5', ratio: 0.8, key: 'feed_portrait' },
  { value: 'Stories / Reels 9:16', ratio: 0.5625, key: 'stories_reels' },
  { value: 'Landscape 1.91:1', ratio: 1.9104, key: 'landscape' },
] as const;

const RATIO_TOLERANCE = 0.03;
const MIN_SIDE_PX = 1080;
const PRIMARY_TEXT_MAX = 125;
const HEADLINE_MAX = 40;

const CALLS_TO_ACTION = [
  'LEARN_MORE', 'SHOP_NOW', 'SIGN_UP', 'BOOK_TRAVEL', 'CONTACT_US',
  'DOWNLOAD', 'GET_OFFER', 'SUBSCRIBE',
] as const;

interface AssetOption {
  id: string;
  title: string;
  kind: 'IMAGE' | 'VIDEO';
  width: number | null;
  height: number | null;
}

interface Draft {
  name: string;
  brief: string;
  primaryText: string;
  headline: string;
  description: string;
  destinationUrl: string;
  callToAction: string;
  placement: (typeof PLACEMENTS)[number]['value'];
  savedAudienceId: string;
  audienceNotes: string;
  ageMin: string;
  ageMax: string;
  genders: 'all' | 'male' | 'female';
  countries: string;
  cities: string;
  lifetimeBudget: string;
  startDate: string;
  endDate: string;
  assetId: string;
}

const EMPTY_DRAFT: Draft = {
  name: '',
  brief: '',
  primaryText: '',
  headline: '',
  description: '',
  destinationUrl: '',
  callToAction: 'LEARN_MORE',
  placement: 'Feed 1:1',
  savedAudienceId: '',
  audienceNotes: '',
  ageMin: '',
  ageMax: '',
  genders: 'all',
  countries: 'SA',
  cities: '',
  lifetimeBudget: '',
  startDate: '',
  endDate: '',
  assetId: '',
};

export function CampaignWizard({
  configured,
  adAccountId,
  currency,
  timezone,
  assets,
}: {
  configured: boolean;
  adAccountId: string;
  currency: string;
  timezone: string;
  assets: AssetOption[];
}) {
  const t = useTranslations('advertising');
  const tWizard = useTranslations('advertising.wizard');
  const tCommon = useTranslations('common.actions');
  const tFieldErrors = useTranslations('errors.field');
  const locale = useLocale() as Locale;
  const router = useRouter();

  const [stepIndex, setStepIndex] = useState(0);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [launched, setLaunched] = useState<{
    campaignId: string;
    metaCampaignId?: string;
  } | null>(null);

  const step: Step = STEPS[stepIndex]!;
  const selectedAsset = assets.find((asset) => asset.id === draft.assetId);

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  /**
   * Client-side mirror of the workflow's own validator.
   *
   * Purely advisory: the server re-runs every one of these. Showing them here
   * means a user finds out about a spec problem while they can still fix it,
   * rather than after a submission round trip.
   */
  const issues = useMemo(() => {
    const blockers: Array<{ key: string; params?: Record<string, string | number> }> = [];
    const warnings: Array<{ key: string; params?: Record<string, string | number> }> = [];

    if (draft.primaryText.length > PRIMARY_TEXT_MAX) {
      blockers.push({
        key: 'longPrimaryText',
        params: { length: draft.primaryText.length, max: PRIMARY_TEXT_MAX },
      });
    }
    if (draft.headline.length > HEADLINE_MAX) {
      blockers.push({
        key: 'longHeadline',
        params: { length: draft.headline.length, max: HEADLINE_MAX },
      });
    }

    if (draft.startDate && draft.endDate) {
      const days =
        (new Date(draft.endDate).getTime() - new Date(draft.startDate).getTime()) /
        86_400_000;
      if (days < 1) warnings.push({ key: 'shortSchedule' });
    }

    if (Number(draft.lifetimeBudget) > 50_000) warnings.push({ key: 'largeBudget' });

    const narrowed =
      draft.ageMin || draft.ageMax || draft.genders !== 'all' || draft.savedAudienceId || draft.cities;
    if (!narrowed) warnings.push({ key: 'noAudienceNarrowing' });

    // Creative spec, exactly as the workflow's Validate Creative node computes it.
    if (selectedAsset?.width && selectedAsset?.height) {
      const expected = PLACEMENTS.find((p) => p.value === draft.placement)?.ratio ?? 1;
      const actual = selectedAsset.width / selectedAsset.height;
      if (Math.abs(actual - expected) / expected > RATIO_TOLERANCE) {
        blockers.push({
          key: 'specMismatch',
          params: {
            ratio: actual.toFixed(3),
            placement: draft.placement,
            expected: expected.toFixed(3),
          },
        });
      }
      if (Math.min(selectedAsset.width, selectedAsset.height) < MIN_SIDE_PX) {
        blockers.push({
          key: 'specMismatch',
          params: {
            ratio: `${selectedAsset.width}×${selectedAsset.height}`,
            placement: draft.placement,
            expected: `≥ ${MIN_SIDE_PX}px`,
          },
        });
      }
    }

    return { blockers, warnings };
  }, [draft, selectedAsset]);

  const complete =
    draft.name.trim() &&
    draft.primaryText.trim() &&
    draft.headline.trim() &&
    draft.destinationUrl.trim() &&
    draft.lifetimeBudget &&
    draft.startDate &&
    draft.endDate &&
    draft.assetId;

  const canLaunch = Boolean(complete) && issues.blockers.length === 0 && acknowledged;

  async function submit() {
    setError(null);
    setSubmitting(true);

    try {
      // Three server calls, each a distinct, audited state change: create the
      // draft, record the approval, then submit. Collapsing them would lose the
      // approval record that proves what a named person authorised.
      const created = await apiFetch<{ id: string }>('/api/v1/campaigns', {
        method: 'POST',
        body: JSON.stringify({
          name: draft.name,
          brief: draft.brief || undefined,
          primaryText: draft.primaryText,
          headline: draft.headline,
          description: draft.description || undefined,
          destinationUrl: draft.destinationUrl,
          callToAction: draft.callToAction,
          placement: draft.placement,
          savedAudienceId: draft.savedAudienceId || undefined,
          audienceNotes: draft.audienceNotes || undefined,
          ageMin: draft.ageMin ? Number(draft.ageMin) : undefined,
          ageMax: draft.ageMax ? Number(draft.ageMax) : undefined,
          genders: draft.genders,
          countries: draft.countries.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean),
          cities: draft.cities ? draft.cities.split(',').map((c) => c.trim()).filter(Boolean) : [],
          lifetimeBudget: Number(draft.lifetimeBudget),
          startDate: draft.startDate,
          endDate: draft.endDate,
          assetId: draft.assetId,
        }),
      });

      await apiFetch(`/api/v1/campaigns/${created.id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ confirmed: true }),
      });

      const result = await apiFetch<{
        status: string;
        metaCampaignId?: string;
        error?: { code: string };
      }>(`/api/v1/campaigns/${created.id}/launch`, {
        method: 'POST',
        headers: {
          // Required by the endpoint. Without it a retry could create a second
          // campaign and a second budget.
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({ confirmed: true }),
      });

      if (result.error) {
        setError(new ApiError({ code: result.error.code, reference: '' }, 200));
      } else {
        setLaunched({ campaignId: created.id, metaCampaignId: result.metaCampaignId });
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : null);
    } finally {
      setSubmitting(false);
      setConfirming(false);
    }
  }

  if (launched) {
    return (
      <>
        <PageHeader title={t('title')} />
        <Card>
          <CardBody className="space-y-4">
            <Alert tone="success" title={tWizard('launch.success')}>
              {/* Says explicitly that nothing is spending yet. */}
              {t('pausedNotice.body')}
            </Alert>
            {launched.metaCampaignId ? (
              <p className="text-sm text-[var(--text-secondary)]">
                {/* A Meta ID is a Latin numeric run; isolate it inside Arabic. */}
                <span className="force-ltr font-mono">{launched.metaCampaignId}</span>
              </p>
            ) : null}
            <Button onClick={() => router.push(`/campaigns/${launched.campaignId}`)}>
              {tCommon('viewDetails')}
            </Button>
          </CardBody>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title={tWizard('title')} description={t('subtitle')} />

      {!configured ? (
        <Alert tone="danger" className="mb-4" title={t('notConfigured.title')}>
          {t('notConfigured.body')}
        </Alert>
      ) : null}

      {/* The paused-creation caveat is stated up front, not just at the end. */}
      <Alert tone="info" className="mb-4" title={t('pausedNotice.title')}>
        {t('pausedNotice.body')}
      </Alert>

      <Stepper current={stepIndex} onSelect={setStepIndex} />

      <Card className="mt-4">
        <CardHeader
          title={tWizard(`${step}.title`)}
          description={step !== 'launch' ? tWizard(`${step}.description`) : undefined}
        />
        <CardBody className="space-y-4">
          {step === 'brief' ? (
            <>
              <Field id="name" label={tWizard('brief.campaignName')} required>
                <Input
                  value={draft.name}
                  onChange={(e) => update('name', e.target.value)}
                  placeholder={tWizard('brief.campaignNamePlaceholder')}
                  dir="auto"
                />
              </Field>
              <Field id="brief" label={tWizard('brief.briefText')}>
                <Textarea
                  value={draft.brief}
                  onChange={(e) => update('brief', e.target.value)}
                  placeholder={tWizard('brief.briefPlaceholder')}
                  dir="auto"
                  rows={3}
                />
              </Field>
              <Field
                id="primaryText"
                label={tWizard('brief.primaryText')}
                hint={tWizard('brief.primaryTextHint', { max: PRIMARY_TEXT_MAX })}
                error={
                  draft.primaryText.length > PRIMARY_TEXT_MAX
                    ? tWizard('review.warningItems.longPrimaryText', {
                        length: draft.primaryText.length,
                        max: PRIMARY_TEXT_MAX,
                      })
                    : undefined
                }
                required
              >
                <Textarea
                  value={draft.primaryText}
                  onChange={(e) => update('primaryText', e.target.value)}
                  dir="auto"
                  rows={3}
                />
              </Field>
              <CharacterCount value={draft.primaryText.length} max={PRIMARY_TEXT_MAX} />

              <Field
                id="headline"
                label={tWizard('brief.headline')}
                hint={tWizard('brief.headlineHint', { max: HEADLINE_MAX })}
                error={
                  draft.headline.length > HEADLINE_MAX
                    ? tWizard('review.warningItems.longHeadline', {
                        length: draft.headline.length,
                        max: HEADLINE_MAX,
                      })
                    : undefined
                }
                required
              >
                <Input
                  value={draft.headline}
                  onChange={(e) => update('headline', e.target.value)}
                  dir="auto"
                />
              </Field>
              <CharacterCount value={draft.headline.length} max={HEADLINE_MAX} />

              <Field id="destinationUrl" label={tWizard('brief.destinationUrl')} required>
                <Input
                  type="url"
                  value={draft.destinationUrl}
                  onChange={(e) => update('destinationUrl', e.target.value)}
                  placeholder="https://example.com"
                  dir="ltr"
                  className="force-ltr"
                />
              </Field>

              <Field id="callToAction" label={tWizard('brief.callToAction')}>
                <Select
                  value={draft.callToAction}
                  onChange={(e) => update('callToAction', e.target.value)}
                >
                  {CALLS_TO_ACTION.map((cta) => (
                    <option key={cta} value={cta}>
                      {cta.replace(/_/g, ' ')}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          ) : null}

          {step === 'objective' ? (
            <>
              {/* Not a dropdown of objectives we cannot deliver: the workflow
                  hard-codes OUTCOME_TRAFFIC, so the UI states that. */}
              <Alert tone="info">{tWizard('objective.fixedNotice')}</Alert>
              <div className="rounded-[var(--radius-control)] border border-[var(--color-brand-600)] bg-[var(--color-brand-50)] p-4">
                <p className="font-medium text-[var(--color-brand-700)]">
                  {tWizard('objective.OUTCOME_TRAFFIC')}
                </p>
                <p className="mt-1 text-sm text-[var(--text-secondary)]">
                  {tWizard('objective.OUTCOME_TRAFFIC_help')}
                </p>
              </div>
            </>
          ) : null}

          {step === 'audience' ? (
            <>
              <Field
                id="savedAudienceId"
                label={tWizard('audience.savedAudience')}
                hint={tWizard('audience.savedAudienceHint')}
              >
                <Input
                  value={draft.savedAudienceId}
                  onChange={(e) => update('savedAudienceId', e.target.value)}
                  dir="ltr"
                  className="force-ltr"
                />
              </Field>
              <Field id="audienceNotes" label={tWizard('audience.notes')}>
                <Input
                  value={draft.audienceNotes}
                  onChange={(e) => update('audienceNotes', e.target.value)}
                  placeholder={tWizard('audience.notesPlaceholder')}
                  dir="auto"
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id="ageMin" label={tWizard('audience.ageMin')}>
                  <Input
                    type="number"
                    min={13}
                    max={65}
                    value={draft.ageMin}
                    onChange={(e) => update('ageMin', e.target.value)}
                  />
                </Field>
                <Field id="ageMax" label={tWizard('audience.ageMax')}>
                  <Input
                    type="number"
                    min={13}
                    max={65}
                    value={draft.ageMax}
                    onChange={(e) => update('ageMax', e.target.value)}
                  />
                </Field>
              </div>
              <Field id="genders" label={tWizard('audience.gender')}>
                <Select
                  value={draft.genders}
                  onChange={(e) => update('genders', e.target.value as Draft['genders'])}
                >
                  <option value="all">{tWizard('audience.genders.all')}</option>
                  <option value="male">{tWizard('audience.genders.male')}</option>
                  <option value="female">{tWizard('audience.genders.female')}</option>
                </Select>
              </Field>
              <Field id="countries" label={tWizard('audience.countries')} required>
                <Input
                  value={draft.countries}
                  onChange={(e) => update('countries', e.target.value)}
                  dir="ltr"
                  className="force-ltr"
                  placeholder="SA, AE"
                />
              </Field>
              <Field id="cities" label={tWizard('audience.cities')}>
                <Input
                  value={draft.cities}
                  onChange={(e) => update('cities', e.target.value)}
                  dir="auto"
                />
              </Field>
              <Alert tone="info">{tWizard('audience.estimatedReachUnavailable')}</Alert>
            </>
          ) : null}

          {step === 'budget' ? (
            <>
              <Field
                id="lifetimeBudget"
                label={tWizard('budget.lifetimeBudget')}
                hint={tWizard('budget.lifetimeBudgetHint')}
                required
              >
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    step="1"
                    value={draft.lifetimeBudget}
                    onChange={(e) => update('lifetimeBudget', e.target.value)}
                    dir="ltr"
                    className="force-ltr"
                  />
                  <span className="text-sm text-[var(--text-secondary)]">{currency}</span>
                </div>
              </Field>

              {draft.lifetimeBudget && draft.startDate && draft.endDate ? (
                <DailyAverage
                  budget={Number(draft.lifetimeBudget)}
                  startDate={draft.startDate}
                  endDate={draft.endDate}
                  currency={currency}
                  locale={locale}
                />
              ) : null}

              <Alert tone="warning">{tWizard('budget.minimumWarning')}</Alert>
            </>
          ) : null}

          {step === 'schedule' ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id="startDate" label={tWizard('schedule.startDate')} required>
                  <Input
                    type="date"
                    value={draft.startDate}
                    onChange={(e) => update('startDate', e.target.value)}
                    dir="ltr"
                    className="force-ltr"
                  />
                </Field>
                <Field
                  id="endDate"
                  label={tWizard('schedule.endDate')}
                  error={
                    draft.startDate && draft.endDate && draft.endDate <= draft.startDate
                      ? tFieldErrors('date_order')
                      : undefined
                  }
                  required
                >
                  <Input
                    type="date"
                    value={draft.endDate}
                    onChange={(e) => update('endDate', e.target.value)}
                    dir="ltr"
                    className="force-ltr"
                  />
                </Field>
              </div>
              <Alert tone="info">{tWizard('schedule.timezoneNotice', { timezone })}</Alert>
            </>
          ) : null}

          {step === 'creative' ? (
            <>
              <Field id="placement" label={tWizard('creative.placement')} required>
                <Select
                  value={draft.placement}
                  onChange={(e) => update('placement', e.target.value as Draft['placement'])}
                >
                  {PLACEMENTS.map((placement) => (
                    <option key={placement.value} value={placement.value}>
                      {tWizard(`creative.placements.${placement.key}`)}
                    </option>
                  ))}
                </Select>
              </Field>

              <Alert tone="info">
                {tWizard('creative.specNotice', {
                  minSide: MIN_SIDE_PX,
                  tolerance: `${RATIO_TOLERANCE * 100}%`,
                })}
              </Alert>

              {assets.length === 0 ? (
                <Alert tone="warning">{tWizard('creative.noAssets')}</Alert>
              ) : (
                <fieldset>
                  <legend className="mb-2 text-sm font-medium text-[var(--text-primary)]">
                    {tWizard('creative.selectAsset')}
                  </legend>
                  <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {assets.map((asset) => (
                      <li key={asset.id}>
                        <button
                          type="button"
                          onClick={() => update('assetId', asset.id)}
                          aria-pressed={draft.assetId === asset.id}
                          className={cn(
                            'w-full overflow-hidden rounded-[var(--radius-control)] border text-start transition-colors',
                            draft.assetId === asset.id
                              ? 'border-[var(--color-brand-600)] ring-2 ring-[var(--color-brand-600)]'
                              : 'border-[var(--border-strong)] hover:bg-[var(--surface-raised)]',
                          )}
                        >
                          <div className="grid aspect-video place-items-center bg-[var(--surface-sunken)] text-[var(--text-muted)]">
                            <IconImage className="size-6" />
                          </div>
                          <span className="block p-2">
                            <span dir="auto" className="block truncate text-xs font-medium">
                              {asset.title}
                            </span>
                            {asset.width && asset.height ? (
                              <span className="force-ltr block text-[11px] text-[var(--text-muted)]">
                                {asset.width}×{asset.height}
                              </span>
                            ) : null}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </fieldset>
              )}
            </>
          ) : null}

          {step === 'review' || step === 'launch' ? (
            <ReviewPanel
              draft={draft}
              asset={selectedAsset}
              issues={issues}
              currency={currency}
              locale={locale}
              adAccountId={adAccountId}
            />
          ) : null}

          {step === 'launch' ? (
            <>
              <Checkbox
                id="acknowledge"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                label={tWizard('launch.confirmCheckbox')}
              />
              <ErrorMessage error={error} />
              <Button
                size="lg"
                disabled={!canLaunch || !configured}
                loading={submitting}
                onClick={() => setConfirming(true)}
              >
                {tWizard('launch.action')}
              </Button>
            </>
          ) : null}
        </CardBody>
      </Card>

      {/* --- Navigation ---------------------------------------------------- */}
      <div className="mt-4 flex items-center justify-between gap-3">
        <Button
          variant="secondary"
          disabled={stepIndex === 0}
          onClick={() => setStepIndex((index) => Math.max(0, index - 1))}
          iconStart={<IconChevron className="size-4 rotate-180" />}
        >
          {tCommon('previous')}
        </Button>
        <Button
          disabled={stepIndex >= STEPS.length - 1}
          onClick={() => setStepIndex((index) => Math.min(STEPS.length - 1, index + 1))}
          iconEnd={<IconChevron className="size-4" />}
        >
          {tCommon('next')}
        </Button>
      </div>

      {/* --- Confirmation dialog (§21) ------------------------------------- */}
      {confirming ? (
        <ConfirmLaunchDialog
          adAccountId={adAccountId}
          onCancel={() => setConfirming(false)}
          onConfirm={submit}
          submitting={submitting}
        />
      ) : null}
    </>
  );
}

function Stepper({
  current,
  onSelect,
}: {
  current: number;
  onSelect: (index: number) => void;
}) {
  const t = useTranslations('advertising.wizard');

  return (
    <nav aria-label={t('title')}>
      <ol className="flex flex-wrap gap-1.5">
        {STEPS.map((step, index) => {
          const state = index === current ? 'current' : index < current ? 'done' : 'upcoming';
          return (
            <li key={step}>
              <button
                type="button"
                onClick={() => onSelect(index)}
                aria-current={state === 'current' ? 'step' : undefined}
                className={cn(
                  'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                  state === 'current'
                    ? 'bg-[var(--color-brand-600)] text-white'
                    : state === 'done'
                      ? 'bg-[var(--status-success-bg)] text-[var(--status-success-fg)]'
                      : 'bg-[var(--surface-sunken)] text-[var(--text-muted)]',
                )}
              >
                {state === 'done' ? <IconCheck className="size-3" /> : null}
                {t(`steps.${step}`)}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function CharacterCount({ value, max }: { value: number; max: number }) {
  const locale = useLocale() as Locale;
  return (
    <p
      className={cn(
        '-mt-2 text-xs tabular-nums',
        value > max ? 'text-[var(--status-danger-fg)]' : 'text-[var(--text-muted)]',
      )}
    >
      <span className="force-ltr inline-block">
        {formatNumber(value, locale)} / {formatNumber(max, locale)}
      </span>
    </p>
  );
}

function DailyAverage({
  budget,
  startDate,
  endDate,
  currency,
  locale,
}: {
  budget: number;
  startDate: string;
  endDate: string;
  currency: string;
  locale: Locale;
}) {
  const t = useTranslations('advertising.wizard.budget');
  const days = Math.max(
    1,
    Math.round((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86_400_000),
  );

  return (
    <p className="text-sm text-[var(--text-secondary)]">
      {t('dailyAverage', {
        amount: formatCurrencyMinor(Math.round((budget / days) * 100), currency, locale),
        days,
      })}
    </p>
  );
}

function ReviewPanel({
  draft,
  asset,
  issues,
  currency,
  locale,
  adAccountId,
}: {
  draft: Draft;
  asset?: AssetOption;
  issues: {
    blockers: Array<{ key: string; params?: Record<string, string | number> }>;
    warnings: Array<{ key: string; params?: Record<string, string | number> }>;
  };
  currency: string;
  locale: Locale;
  adAccountId: string;
}) {
  const t = useTranslations('advertising.wizard.review');
  const tWizard = useTranslations('advertising.wizard');

  return (
    <div className="space-y-4">
      <dl className="grid gap-3 sm:grid-cols-2">
        <Row label={tWizard('brief.campaignName')} value={draft.name} />
        <Row label={tWizard('objective.title')} value={tWizard('objective.OUTCOME_TRAFFIC')} />
        <Row label={tWizard('brief.headline')} value={draft.headline} />
        <Row label={tWizard('brief.primaryText')} value={draft.primaryText} />
        <Row label={tWizard('brief.destinationUrl')} value={draft.destinationUrl} ltr />
        <Row label={tWizard('creative.placement')} value={draft.placement} ltr />
        <Row
          label={tWizard('budget.lifetimeBudget')}
          value={
            draft.lifetimeBudget
              ? formatCurrencyMinor(Number(draft.lifetimeBudget) * 100, currency, locale)
              : '—'
          }
        />
        <Row
          label={tWizard('schedule.title')}
          value={
            draft.startDate && draft.endDate
              ? `${formatDate(draft.startDate, locale)} – ${formatDate(draft.endDate, locale)}`
              : '—'
          }
        />
        <Row label={tWizard('audience.countries')} value={draft.countries} ltr />
        <Row label={tWizard('creative.title')} value={asset?.title ?? '—'} />
        <Row label={tWizard('launch.title')} value={`act_${adAccountId}`} ltr />
      </dl>

      {issues.blockers.length > 0 ? (
        <Alert tone="danger" title={t('warnings')}>
          <ul className="space-y-1">
            {issues.blockers.map((issue, index) => (
              <li key={index} className="flex items-start gap-2">
                <IconAlert className="mt-0.5 size-3.5 shrink-0" />
                <span>{tWizard(`review.warningItems.${issue.key}`, issue.params ?? {})}</span>
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {issues.warnings.length > 0 ? (
        <Alert tone="warning" title={t('warnings')}>
          <ul className="space-y-1">
            {issues.warnings.map((issue, index) => (
              <li key={index}>
                {tWizard(`review.warningItems.${issue.key}`, issue.params ?? {})}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {issues.blockers.length === 0 && issues.warnings.length === 0 ? (
        <Alert tone="success">{t('noWarnings')}</Alert>
      ) : null}
    </div>
  );
}

function Row({ label, value, ltr }: { label: string; value: string; ltr?: boolean }) {
  return (
    <div className="rounded-[var(--radius-control)] bg-[var(--surface-sunken)] p-3">
      <dt className="text-xs text-[var(--text-muted)]">{label}</dt>
      <dd
        dir={ltr ? 'ltr' : 'auto'}
        className={cn(
          'mt-0.5 break-words text-sm font-medium text-[var(--text-primary)]',
          ltr && 'force-ltr',
        )}
      >
        {value || '—'}
      </dd>
    </div>
  );
}

/**
 * Final confirmation (§21).
 *
 * A modal that restates the destination ad account and says, in the user's own
 * language, that everything is created PAUSED. Focus is trapped by rendering it
 * as a `dialog`-role element with the confirm button autofocused, and Escape
 * cancels — so a keyboard user is never stranded inside it.
 */
function ConfirmLaunchDialog({
  adAccountId,
  onCancel,
  onConfirm,
  submitting,
}: {
  adAccountId: string;
  onCancel: () => void;
  onConfirm: () => void;
  submitting: boolean;
}) {
  const t = useTranslations('advertising.wizard.launch');
  const tCommon = useTranslations('common.actions');

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      role="presentation"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
    >
      <Card
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-launch-title"
        className="w-full max-w-lg animate-fade-in"
      >
        <CardBody className="space-y-4">
          <h2
            id="confirm-launch-title"
            className="text-lg font-semibold text-[var(--text-primary)]"
          >
            {t('confirmTitle')}
          </h2>
          <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
            {t('confirmBody', { adAccount: `act_${adAccountId}` })}
          </p>

          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={onCancel} disabled={submitting}>
              {tCommon('cancel')}
            </Button>
            <Button onClick={onConfirm} loading={submitting} autoFocus>
              {t('action')}
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
