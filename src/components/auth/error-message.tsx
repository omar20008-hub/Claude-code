'use client';

import { useTranslations } from 'next-intl';
import { Alert } from '@/components/ui/primitives';
import type { ApiError } from './api-error';
import type { FieldError } from '@/lib/errors';

/**
 * Renders an API error in the reader's language (§38).
 *
 * The user sees a localized sentence plus a reference id they can quote to
 * support. They never see a stack trace, a SQL message or an upstream service
 * name — those live in the server log, findable by the same reference.
 */
export function ErrorMessage({ error }: { error: ApiError | null }) {
  const t = useTranslations('errors');

  if (!error) return null;

  // An unrecognised code still produces a sentence rather than a blank alert.
  const knownCodes = new Set([
    'unauthorized', 'forbidden', 'invalid_credentials', 'account_locked',
    'email_not_verified', 'email_already_registered', 'invalid_token',
    'token_expired', 'session_expired', 'validation_failed', 'not_found',
    'conflict', 'rate_limited', 'payload_too_large', 'unsupported_media_type',
    'idempotency_key_reused', 'integration_not_configured',
    'integration_unavailable', 'agent_unavailable', 'agent_timeout',
    'agent_failed', 'capability_unavailable', 'storage_not_configured',
    'campaign_not_launchable', 'campaign_already_launched',
    'invalid_state_transition', 'internal_error', 'network',
  ]);

  const message = knownCodes.has(error.code)
    ? t(error.code, error.params ?? {})
    : t('generic');

  return (
    <Alert tone="danger" title={message}>
      {error.reference ? (
        <p className="mt-1 text-xs opacity-80">
          {/* The id is Latin text; isolate it so it does not reorder inside
              Arabic prose. */}
          <span className="force-ltr inline-block">{t('reference', { id: error.reference })}</span>
        </p>
      ) : null}
    </Alert>
  );
}

/**
 * Localizes one field-level validation failure.
 *
 * The API sends `{ path, rule, params }` — never prose — so the same 422 renders
 * as "استخدم ١٢ حرفًا على الأقل." or "Use at least 12 characters." depending
 * only on who is looking at it.
 */
export function useFieldError() {
  const t = useTranslations('errors.field');

  return function fieldMessage(field: FieldError | undefined): string | undefined {
    if (!field) return undefined;
    const knownRules = new Set([
      'required', 'invalid', 'email', 'url', 'too_short', 'too_long',
      'too_small', 'too_big', 'too_common', 'too_simple', 'mismatch',
      'date_order', 'date_past', 'not_an_option',
    ]);
    return knownRules.has(field.rule)
      ? t(field.rule, field.params ?? {})
      : t('invalid');
  };
}
