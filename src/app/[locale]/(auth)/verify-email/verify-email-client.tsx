'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/routing';
import { Alert, Button, Card, CardBody, Spinner } from '@/components/ui/primitives';
import { ErrorMessage } from '@/components/auth/error-message';
import { apiFetch, ApiError } from '@/components/auth/api-error';

export function VerifyEmailClient({ token }: { token: string | null }) {
  const t = useTranslations('auth.verifyEmail');
  const tLogin = useTranslations('auth.login');
  const [state, setState] = useState<'idle' | 'working' | 'done'>(token ? 'working' : 'idle');
  const [error, setError] = useState<ApiError | null>(null);
  // React 18+ runs effects twice in development StrictMode; without this guard
  // the second run would redeem an already-consumed token and show a failure.
  const attempted = useRef(false);

  useEffect(() => {
    if (!token || attempted.current) return;
    attempted.current = true;

    apiFetch('/api/v1/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify({ token }),
    })
      .then(() => setState('done'))
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught : null);
        setState('idle');
      });
  }, [token]);

  return (
    <Card>
      <CardBody className="space-y-4 p-6">
        <h1 className="text-xl font-semibold text-[var(--text-primary)]">{t('title')}</h1>

        {state === 'working' ? (
          <p className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
            <Spinner className="size-4" />
            {t('title')}
          </p>
        ) : null}

        {state === 'done' ? <Alert tone="success" title={t('success')} /> : null}

        <ErrorMessage error={error} />

        {!token && state === 'idle' && !error ? (
          <Alert tone="warning" title={t('pending')} />
        ) : null}

        <Link href="/login" className="block">
          <Button fullWidth variant={state === 'done' ? 'primary' : 'secondary'}>
            {tLogin('submit')}
          </Button>
        </Link>
      </CardBody>
    </Card>
  );
}
