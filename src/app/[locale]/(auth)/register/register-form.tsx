'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Link } from '@/i18n/routing';
import { Alert, Button, Card, CardBody, Field, Input } from '@/components/ui/primitives';
import { ErrorMessage, useFieldError } from '@/components/auth/error-message';
import { apiFetch, ApiError } from '@/components/auth/api-error';
import { PASSWORD_MIN_LENGTH } from '@/lib/password-policy';
import type { Locale } from '@/i18n/config';

export function RegisterForm() {
  const t = useTranslations('auth.register');
  const tCommon = useTranslations('common.labels');
  const tPassword = useTranslations('auth.password');
  const tVerify = useTranslations('auth.verifyEmail');
  const locale = useLocale() as Locale;
  const fieldMessage = useFieldError();

  const [form, setForm] = useState({
    organizationName: '',
    name: '',
    email: '',
    password: '',
  });
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [registeredEmail, setRegisteredEmail] = useState<string | null>(null);

  function update(key: keyof typeof form, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const result = await apiFetch<{ email: string }>('/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({ ...form, locale }),
      });
      setRegisteredEmail(result.email);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : null);
    } finally {
      setSubmitting(false);
    }
  }

  // No session is issued at registration: the account stays
  // PENDING_VERIFICATION until the emailed link is opened, which is what makes
  // email verification meaningful rather than decorative.
  if (registeredEmail) {
    return (
      <Card>
        <CardBody className="space-y-4 p-6">
          <h1 className="text-xl font-semibold text-[var(--text-primary)]">
            {tVerify('title')}
          </h1>
          <Alert tone="success" title={t('success')}>
            {tVerify('subtitle', { email: registeredEmail })}
          </Alert>
          <Link
            href="/login"
            className="block text-center text-sm text-[var(--text-brand)] hover:underline"
          >
            {t('signIn')}
          </Link>
        </CardBody>
      </Card>
    );
  }

  const fields = error?.fieldMap() ?? {};

  return (
    <Card>
      <CardBody className="space-y-5 p-6">
        <div>
          <h1 className="text-xl font-semibold text-[var(--text-primary)]">{t('title')}</h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">{t('subtitle')}</p>
        </div>

        <ErrorMessage error={error} />

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <Field
            id="organizationName"
            label={t('organizationName')}
            hint={t('organizationNameHint')}
            error={fieldMessage(fields.organizationName)}
            required
          >
            <Input
              value={form.organizationName}
              onChange={(event) => update('organizationName', event.target.value)}
              autoComplete="organization"
              required
            />
          </Field>

          <Field
            id="name"
            label={t('fullName')}
            error={fieldMessage(fields.name)}
            required
          >
            <Input
              value={form.name}
              onChange={(event) => update('name', event.target.value)}
              autoComplete="name"
              required
            />
          </Field>

          <Field
            id="email"
            label={tCommon('email')}
            error={fieldMessage(fields.email)}
            required
          >
            <Input
              type="email"
              value={form.email}
              onChange={(event) => update('email', event.target.value)}
              autoComplete="username"
              dir="ltr"
              className="force-ltr"
              required
            />
          </Field>

          <Field
            id="password"
            label={tCommon('password')}
            hint={tPassword('requirements', { min: PASSWORD_MIN_LENGTH })}
            error={fieldMessage(fields.password)}
            required
          >
            <Input
              type="password"
              value={form.password}
              onChange={(event) => update('password', event.target.value)}
              autoComplete="new-password"
              dir="ltr"
              className="force-ltr"
              minLength={PASSWORD_MIN_LENGTH}
              required
            />
          </Field>

          <Button type="submit" fullWidth loading={submitting} size="lg">
            {t('submit')}
          </Button>
        </form>

        <p className="text-center text-sm text-[var(--text-secondary)]">
          {t('haveAccount')}{' '}
          <Link href="/login" className="font-medium text-[var(--text-brand)] hover:underline">
            {t('signIn')}
          </Link>
        </p>
      </CardBody>
    </Card>
  );
}
