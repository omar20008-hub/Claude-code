/**
 * Vitest global setup.
 *
 * Loads the test environment before any module reads `process.env`. Config in
 * src/server/config/env.ts caches its parse on first access, so this file must
 * run first — it is registered via `setupFiles` in vitest.config.ts.
 */
// NODE_ENV is typed read-only by @types/node; Vitest already sets it to 'test'.
process.env.DATABASE_URL ??=
  'postgres://postgres@127.0.0.1:5432/ai_workforce_test';
process.env.APP_URL ??= 'http://localhost:3000';
process.env.LOG_LEVEL ??= 'silent';

// Deterministic 32-byte secrets so signature tests are reproducible.
process.env.AUTH_SECRET ??= 'test-auth-secret-0123456789abcdef0123456789abcdef';
process.env.ENCRYPTION_KEY ??= 'test-encryption-key-0123456789abcdef0123456789ab';
process.env.N8N_CALLBACK_SECRETS ??=
  'test-callback-secret-0123456789abcdef0123456789ab';
