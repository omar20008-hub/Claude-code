import pino from 'pino';
import { env } from '@/server/config/env';

/**
 * Structured logging.
 *
 * The redaction list is a security control, not a convenience: §32 forbids
 * logging passwords, tokens, API keys and OAuth secrets. `redact` runs inside
 * pino before serialization, so a secret that lands in a log object never
 * reaches a transport, a file, or an aggregator.
 *
 * Like the database client, the logger is created lazily so importing this
 * module during `next build` does not require runtime configuration.
 */
const REDACTED_PATHS = [
  'password',
  'passwordHash',
  'newPassword',
  'currentPassword',
  'token',
  'tokenHash',
  'sessionToken',
  'refreshToken',
  'accessToken',
  'apiKey',
  'secret',
  'clientSecret',
  'authorization',
  'cookie',
  'setCookie',
  'signature',
  // One level down, for the common `{ req: { headers: {...} } }` shape.
  '*.password',
  '*.token',
  '*.secret',
  '*.authorization',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-aiw-signature"]',
  'headers.authorization',
  'headers.cookie',
];

export type Logger = pino.Logger;

let instance: Logger | undefined;

function realLogger(): Logger {
  instance ??= pino({
    level: env().LOG_LEVEL,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    base: {
      service: env().OTEL_SERVICE_NAME,
      env: env().NODE_ENV,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
  return instance;
}

export const logger: Logger = new Proxy({} as Logger, {
  get(_target, property, receiver) {
    return Reflect.get(realLogger(), property, receiver);
  },
});

/**
 * Returns a child logger bound to a correlation id, plus whatever request
 * context the caller has. Every log line emitted while handling one request
 * carries the same `correlationId`, which is also returned to the client in
 * the `X-Correlation-Id` header and embedded in user-facing error references.
 */
export function requestLogger(context: {
  correlationId: string;
  tenantId?: string;
  userId?: string;
  route?: string;
  method?: string;
}): Logger {
  return realLogger().child(context);
}
