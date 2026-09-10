'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
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

export function ResetPasswordForm({ token }: { token: string | null }) {
  const t = useTranslations('auth.resetPassword');
  const tPassword = useTranslations('auth.password');
  const tErrors = useTranslations('errors.field');
  const fieldMessage = useFieldError();

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (mismatch || !token) return;

    setError(null);
    setSubmitting(true);

    try {
      await apiFetch('/api/v1/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ token, newPassword }),
      });
      setDone(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : null);
    } finally {
      setSubmitting(false);
    }
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
        {done ? <Alert tone="success" title={t('success')} /> : null}
        {!token && !done ? <Alert tone="danger" title={t('expired')} /> : null}

        {token && !done ? (
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <Field
              id="newPassword"
              label={t('newPassword')}
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
              id="confirmPassword"
              label={t('confirmPassword')}
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

            <Button type="submit" fullWidth loading={submitting} disabled={mismatch} size="lg">
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
