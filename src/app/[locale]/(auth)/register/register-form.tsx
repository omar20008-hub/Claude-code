'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Link } from '@/i18n/routing';
import {
  Alert,
  Button,
  Card,
  CardBody,
} from '@/components/ui/primitives';
import {
  Field,
  Input,
} from '@/components/ui/form';
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

  if (registeredEmail) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 py-12 bg-gradient-to-br from-slate-50 to-green-50">
        <Card className="w-full max-w-md shadow-lg">
          <CardBody className="space-y-6 p-12">
            <div className="text-center">
              <div className="text-4xl mb-4">🎉</div>
              <h1 className="text-2xl font-bold text-[var(--text-primary)]">
                {tVerify('title')}
              </h1>
            </div>
            <Alert tone="success" title={t('success')}>
              {tVerify('subtitle', { email: registeredEmail })}
            </Alert>
            <Link
              href="/login"
              className="block w-full text-center px-4 py-3 bg-[var(--text-brand)] text-white rounded-lg font-medium hover:opacity-90 transition"
            >
              {t('signIn')}
            </Link>
          </CardBody>
        </Card>
      </div>
    );
  }

  const fields = error?.fieldMap() ?? {};

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12 bg-gradient-to-br from-slate-50 to-green-50">
      <Card className="w-full max-w-md shadow-lg">
        <CardBody className="space-y-6 p-12">
          <div className="text-center">
            <div className="text-4xl mb-3">🤖</div>
            <h1 className="text-2xl font-bold text-[var(--text-primary)]">{t('title')}</h1>
            <p className="mt-2 text-sm text-[var(--text-secondary)]">{t('subtitle')}</p>
          </div>

          {error && <ErrorMessage error={error} />}

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

        <div className="text-center text-sm text-[var(--text-secondary)]">
          {t('haveAccount')}{' '}
          <Link href="/login" className="font-semibold text-[var(--text-brand)] hover:underline">
            {t('signIn')}
          </Link>
        </div>
      </CardBody>
    </Card>
    </div>
  );
}
