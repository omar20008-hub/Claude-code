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
import { ErrorMessage } from '@/components/auth/error-message';
import { apiFetch, ApiError } from '@/components/auth/api-error';
import type { Locale } from '@/i18n/config';

export function ForgotPasswordForm() {
  const t = useTranslations('auth.forgotPassword');
  const tCommon = useTranslations('common.labels');
  const locale = useLocale() as Locale;

  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await apiFetch('/api/v1/auth/request-password-reset', {
        method: 'POST',
        body: JSON.stringify({ email, locale }),
      });
      // The same confirmation is shown whether or not the address exists.
      // Anything else would make this form an account-enumeration oracle.
      setSent(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : null);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardBody className="space-y-5 p-6">
        <div>
          <h1 className="text-xl font-semibold text-[var(--text-primary)]">{t('title')}</h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">{t('subtitle')}</p>
        </div>

        <ErrorMessage error={error} />
        {sent ? <Alert tone="success" title={t('sent')} /> : null}

        {!sent ? (
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <Field id="email" label={tCommon('email')} required>
              <Input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="username"
                dir="ltr"
                className="force-ltr"
                required
              />
            </Field>
            <Button type="submit" fullWidth loading={submitting} size="lg">
              {t('submit')}
            </Button>
          </form>
        ) : null}

        <Link
          href="/login"
          className="block text-center text-sm text-[var(--text-brand)] hover:underline"
        >
          {t('backToLogin')}
        </Link>
      </CardBody>
    </Card>
  );
}
