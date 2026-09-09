'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Link, useRouter } from '@/i18n/routing';
import { Button, Card, CardBody, Field, Input } from '@/components/ui/primitives';
import { ErrorMessage, useFieldError } from '@/components/auth/error-message';
import { apiFetch, ApiError } from '@/components/auth/api-error';
import type { Locale } from '@/i18n/config';

export function LoginForm() {
  const t = useTranslations('auth.login');
  const tCommon = useTranslations('common.labels');
  const tPassword = useTranslations('auth.password');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const fieldMessage = useFieldError();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const result = await apiFetch<{ locale: Locale }>('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });

      // Honour the account's saved language: a user who set Arabic should land
      // on the Arabic dashboard even if they signed in from an English page.
      router.replace('/dashboard', { locale: result.locale ?? locale });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : null);
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

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <Field id="email" label={tCommon('email')} error={fieldMessage(fields.email)} required>
            <Input
              type="email"
              name="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="username"
              // Email addresses are Latin regardless of UI language; forcing
              // LTR keeps the caret and the text from reordering in Arabic.
              dir="ltr"
              className="force-ltr"
              required
            />
          </Field>

          <Field
            id="password"
            label={tCommon('password')}
            error={fieldMessage(fields.password)}
            required
          >
            <div className="relative">
              <Input
                type={showPassword ? 'text' : 'password'}
                name="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                dir="ltr"
                className="force-ltr pe-11"
                required
              />
              {/* `end-1` pins the reveal button to the reading end, so it sits
                  on the right in English and the left in Arabic. */}
              <button
                type="button"
                onClick={() => setShowPassword((value) => !value)}
                aria-label={showPassword ? tPassword('hide') : tPassword('show')}
                aria-pressed={showPassword}
                className="absolute inset-block-0 end-1 my-auto grid size-8 place-items-center rounded-[var(--radius-control)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden="true">
                  {showPassword ? (
                    <path
                      d="M3 3l18 18M10.6 10.7a2 2 0 0 0 2.8 2.8M9.4 5.3A9.6 9.6 0 0 1 12 5c5 0 9 4.5 9 7a11 11 0 0 1-2.4 3.5M6.2 6.7A11.6 11.6 0 0 0 3 12c0 2.5 4 7 9 7a9.5 9.5 0 0 0 3.4-.6"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                    />
                  ) : (
                    <>
                      <path
                        d="M3 12s3.5-7 9-7 9 7 9 7-3.5 7-9 7-9-7-9-7Z"
                        stroke="currentColor"
                        strokeWidth="1.7"
                      />
                      <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.7" />
                    </>
                  )}
                </svg>
              </button>
            </div>
          </Field>

          <div className="flex justify-end">
            <Link
              href="/forgot-password"
              className="text-sm text-[var(--text-brand)] hover:underline"
            >
              {t('forgotPassword')}
            </Link>
          </div>

          <Button type="submit" fullWidth loading={submitting} size="lg">
            {t('submit')}
          </Button>
        </form>

        <p className="text-center text-sm text-[var(--text-secondary)]">
          {t('noAccount')}{' '}
          <Link href="/register" className="font-medium text-[var(--text-brand)] hover:underline">
            {t('createOne')}
          </Link>
        </p>
      </CardBody>
    </Card>
  );
}
