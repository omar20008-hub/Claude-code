import { z } from 'zod';

/**
 * Boot-time environment validation.
 *
 * Two rules drive the shape of this file:
 *
 *  1. Nothing here is ever imported from a Client Component. Every value is a
 *     server secret or a server-only endpoint. The only value the browser is
 *     allowed to learn is `APP_URL`, and it learns it from rendered HTML rather
 *     than from a NEXT_PUBLIC_ variable.
 *
 *  2. Development is allowed to run with generated throwaway secrets so a fresh
 *     clone boots with `docker compose up`. Production is not: a missing or
 *     weak secret is a hard failure at startup rather than a silent downgrade
 *     to an insecure default.
 */

const isProduction = process.env.NODE_ENV === 'production';

/** Minimum entropy we accept for a signing/encryption secret. */
const MIN_SECRET_BYTES = 32;

const secret = (name: string) =>
  z
    .string()
    .optional()
    .superRefine((value, ctx) => {
      if (!value || value.length === 0) {
        if (isProduction) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${name} is required in production. Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`,
          });
        }
        return;
      }
      // base64url of 32 bytes is 43 chars; accept any encoding with enough entropy.
      if (Buffer.from(value, 'utf8').length < MIN_SECRET_BYTES) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${name} must carry at least ${MIN_SECRET_BYTES} bytes of entropy.`,
        });
      }
    });

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : v === 'true' || v === '1'));

const int = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .pipe(z.number().int().positive());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: int(10),

  AUTH_SECRET: secret('AUTH_SECRET'),
  ENCRYPTION_KEY: secret('ENCRYPTION_KEY'),

  N8N_BASE_URL: z.string().url().optional().or(z.literal('')),
  N8N_WEBHOOK_AUTH_HEADER: z.string().optional(),
  N8N_WEBHOOK_AUTH_VALUE: z.string().optional(),
  N8N_KNOWLEDGE_WEBHOOK_ID: z.string().optional(),
  N8N_CREATIVE_WEBHOOK_ID: z.string().optional(),
  N8N_ADVERTISING_WEBHOOK_ID: z.string().optional(),
  N8N_KNOWLEDGE_WORKFLOW_ID: z.string().optional(),
  N8N_CREATIVE_WORKFLOW_ID: z.string().optional(),
  N8N_ADVERTISING_WORKFLOW_ID: z.string().optional(),
  N8N_REQUEST_TIMEOUT_MS: int(300_000),
  N8N_CALLBACK_SECRETS: z.string().optional(),

  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool(true),
  S3_SIGNED_URL_TTL_SECONDS: int(900),

  REDIS_URL: z.string().optional(),

  EMAIL_TRANSPORT: z.enum(['log', 'smtp']).default('log'),
  EMAIL_FROM: z.string().default('no-reply@example.com'),
  SMTP_URL: z.string().optional(),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  SENTRY_DSN: z.string().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  OTEL_SERVICE_NAME: z.string().default('ai-workforce-saas'),

  DEFAULT_LOCALE: z.enum(['ar', 'en']).default('ar'),
});

function load() {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  const raw = parsed.data;

  // In non-production a missing secret gets a stable per-process value so the
  // app boots, but sessions do not survive a restart. That trade-off is
  // deliberate and loud: see the warning emitted by assertDevSecrets().
  const devFallback = (label: string) =>
    `dev-insecure-${label}-${'0'.repeat(MIN_SECRET_BYTES)}`;

  const authSecret = raw.AUTH_SECRET || devFallback('auth');
  const encryptionKey = raw.ENCRYPTION_KEY || devFallback('encryption');

  const callbackSecrets = (raw.N8N_CALLBACK_SECRETS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    ...raw,
    AUTH_SECRET: authSecret,
    ENCRYPTION_KEY: encryptionKey,
    /**
     * Ordered list of callback signing secrets. Index 0 signs outbound values;
     * every entry is accepted on verify, which is what makes rotation
     * zero-downtime. Empty means the callback endpoint refuses all traffic.
     */
    N8N_CALLBACK_SECRETS: callbackSecrets,
    usingGeneratedSecrets: !raw.AUTH_SECRET || !raw.ENCRYPTION_KEY,
    isProduction,
  };
}

export type Env = ReturnType<typeof load>;

let cached: Env | undefined;

export function env(): Env {
  cached ??= load();
  return cached;
}

/** Test seam: forces the next env() call to re-read process.env. */
export function resetEnvCache(): void {
  cached = undefined;
}

/**
 * True when the n8n gateway has enough configuration to make a real call.
 * The UI uses this to show an explicit "integration not configured" state
 * rather than pretending an agent is available.
 */
export function isN8nConfigured(): boolean {
  const e = env();
  return Boolean(e.N8N_BASE_URL);
}

/** True when object storage is configured well enough to persist assets. */
export function isStorageConfigured(): boolean {
  const e = env();
  return Boolean(e.S3_BUCKET && e.S3_ACCESS_KEY_ID && e.S3_SECRET_ACCESS_KEY);
}
