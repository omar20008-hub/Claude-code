/**
 * Application error taxonomy.
 *
 * Two properties matter here:
 *
 *  - `code` is a stable, machine-readable identifier that doubles as an i18n
 *    key (`errors.<code>`). It is what the browser renders, in the user's
 *    language. It never contains a technical detail.
 *  - `internalMessage` is the engineer-facing detail. It is logged and never
 *    serialized into an HTTP response body.
 *
 * That split is what satisfies §38: the user sees "تعذر تنفيذ العملية حاليًا"
 * plus a reference id, while the operator sees the Postgres error.
 */

export type ErrorCode =
  // Authentication / authorization
  | 'unauthorized'
  | 'forbidden'
  | 'invalid_credentials'
  | 'account_locked'
  | 'email_not_verified'
  | 'email_already_registered'
  | 'invalid_token'
  | 'token_expired'
  | 'session_expired'
  // Request shape
  | 'validation_failed'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'idempotency_key_reused'
  // Integrations
  | 'integration_not_configured'
  | 'integration_unavailable'
  | 'agent_unavailable'
  | 'agent_timeout'
  | 'agent_failed'
  | 'capability_unavailable'
  | 'storage_not_configured'
  // Domain
  | 'campaign_not_launchable'
  | 'campaign_already_launched'
  | 'invalid_state_transition'
  // Fallback
  | 'internal_error';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  invalid_credentials: 401,
  account_locked: 423,
  email_not_verified: 403,
  email_already_registered: 409,
  invalid_token: 400,
  token_expired: 410,
  session_expired: 401,

  validation_failed: 422,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  payload_too_large: 413,
  unsupported_media_type: 415,
  idempotency_key_reused: 409,

  integration_not_configured: 503,
  integration_unavailable: 502,
  agent_unavailable: 503,
  agent_timeout: 504,
  agent_failed: 502,
  capability_unavailable: 501,
  storage_not_configured: 503,

  campaign_not_launchable: 409,
  campaign_already_launched: 409,
  invalid_state_transition: 409,

  internal_error: 500,
};

export interface FieldError {
  /** Dotted path into the submitted payload, e.g. `budget.lifetime`. */
  path: string;
  /** i18n key under `errors.field.*`, e.g. `required`, `too_long`. */
  rule: string;
  /** Interpolation values for the message, e.g. `{ max: 40 }`. */
  params?: Record<string, string | number>;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly fields?: FieldError[];
  /**
   * Values interpolated into the localized message, e.g. `{ retryAfter: 30 }`
   * for `errors.rate_limited`.
   */
  readonly params?: Record<string, string | number>;
  /** Engineer-facing context. Logged, never returned to the client. */
  readonly internalMessage?: string;
  override readonly cause?: unknown;

  constructor(
    code: ErrorCode,
    options: {
      fields?: FieldError[];
      params?: Record<string, string | number>;
      internalMessage?: string;
      cause?: unknown;
    } = {},
  ) {
    // The Error message is for logs and stack traces only.
    super(options.internalMessage ?? code);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.fields = options.fields;
    this.params = options.params;
    this.internalMessage = options.internalMessage;
    this.cause = options.cause;
  }

  /** True for errors we expect in normal operation and log at `warn`. */
  get isExpected(): boolean {
    return this.status < 500;
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

/**
 * Narrows an unknown thrown value to an AppError, collapsing anything
 * unrecognised to `internal_error` while preserving the original for logging.
 */
export function toAppError(e: unknown): AppError {
  if (isAppError(e)) return e;
  return new AppError('internal_error', {
    internalMessage: e instanceof Error ? e.message : String(e),
    cause: e,
  });
}
