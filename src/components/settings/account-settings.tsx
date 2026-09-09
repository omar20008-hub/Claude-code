'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/routing';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  Input,
  Select,
} from '@/components/ui/primitives';
import { ErrorMessage, useFieldError } from '@/components/auth/error-message';
import { apiFetch, ApiError } from '@/components/auth/api-error';
import { PASSWORD_MIN_LENGTH } from '@/lib/password-policy';
import { locales, localeConfig, type Locale } from '@/i18n/config';

/**
 * Account settings.
 *
 * The interface-language control writes the same preference the switcher does,
 * so a user has one setting rather than two that can disagree. Changing it
 * navigates to the new locale immediately — the setting takes effect where you
 * can see it, not on the next sign-in.
 */
export function AccountSettings({
  name,
  email,
  locale,
  organizationName,
  timezone,
  currency,
}: {
  name: string;
  email: string;
  locale: Locale;
  organizationName: string;
  timezone: string;
  currency: string;
}) {
  const t = useTranslations('settings');
  const tAccount = useTranslations('settings.account');
  const tOrg = useTranslations('settings.organization');
  const tCommon = useTranslations('common.labels');
  const tActions = useTranslations('common.actions');
  const tPassword = useTranslations('auth.password');
  const tReset = useTranslations('auth.resetPassword');
  const tErrors = useTranslations('errors.field');
  const router = useRouter();
  const fieldMessage = useFieldError();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;

  async function switchLocale(next: Locale) {
    await apiFetch('/api/v1/me/locale', {
      method: 'PATCH',
      body: JSON.stringify({ locale: next }),
    });
    router.replace('/settings', { locale: next });
    router.refresh();
  }

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    if (mismatch) return;

    setError(null);
    setChanged(false);
    setSaving(true);

    try {
      await apiFetch('/api/v1/me/password', {
        method: 'PATCH',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setChanged(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      // Changing a password revokes every session, including this one.
      setTimeout(() => window.location.assign('/'), 2500);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : null);
    } finally {
      setSaving(false);
    }
  }

  const fields = error?.fieldMap() ?? {};

  return (
    <Card>
      <CardHeader title={tAccount('title')} description={t('subtitle')} />
      <CardBody className="space-y-5">
        <dl className="space-y-2 text-sm">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-[var(--text-muted)]">{tAccount('name')}</dt>
            <dd className="font-medium text-[var(--text-primary)]">{name}</dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-[var(--text-muted)]">{tCommon('email')}</dt>
            {/* Latin text in possibly-Arabic UI: isolated so it cannot reorder. */}
            <dd className="force-ltr font-medium text-[var(--text-primary)]">{email}</dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-[var(--text-muted)]">{tCommon('organization')}</dt>
            <dd className="font-medium text-[var(--text-primary)]">{organizationName}</dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-[var(--text-muted)]">{tOrg('timezone')}</dt>
            <dd className="force-ltr font-medium text-[var(--text-primary)]">{timezone}</dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-[var(--text-muted)]">{tOrg('currency')}</dt>
            <dd className="force-ltr font-medium text-[var(--text-primary)]">{currency}</dd>
          </div>
        </dl>

        <p className="text-xs text-[var(--text-muted)]">{tAccount('emailImmutable')}</p>

        <Field
          id="interface-locale"
          label={tAccount('language')}
          hint={tAccount('languageHint')}
        >
          <Select
            value={locale}
            onChange={(event) => void switchLocale(event.target.value as Locale)}
          >
            {locales.map((value) => (
              // Each option carries its own lang so the endonym renders in its
              // own script inside the native select.
              <option key={value} value={value} lang={value}>
                {localeConfig[value].label}
              </option>
            ))}
          </Select>
        </Field>

        <form onSubmit={changePassword} className="space-y-3 border-t border-[var(--border-subtle)] pt-4">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            {tAccount('changePassword')}
          </h3>

          <ErrorMessage error={error} />
          {changed ? <Alert tone="success" title={tAccount('passwordChanged')} /> : null}

          <Field
            id="currentPassword"
            label={tAccount('currentPassword')}
            error={fieldMessage(fields.currentPassword)}
            required
          >
            <Input
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              autoComplete="current-password"
              dir="ltr"
              className="force-ltr"
              required
            />
          </Field>

          <Field
            id="settingsNewPassword"
            label={tReset('newPassword')}
            hint={tPassword('requirements', { min: PASSWORD_MIN_LENGTH })}
            error={fieldMessage(fields.newPassword)}
            required
          >
            <Input
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              autoComplete="new-password"
              dir="ltr"
              className="force-ltr"
              minLength={PASSWORD_MIN_LENGTH}
              required
            />
          </Field>

          <Field
            id="settingsConfirmPassword"
            label={tReset('confirmPassword')}
            error={mismatch ? tErrors('mismatch') : undefined}
            required
          >
            <Input
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              autoComplete="new-password"
              dir="ltr"
              className="force-ltr"
              required
            />
          </Field>

          <Button type="submit" loading={saving} disabled={mismatch}>
            {tActions('save')}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
