/**
 * Drizzle wraps a driver error in its own `DrizzleQueryError`, whose message is
 * "Failed query: …" and whose `cause` carries the real Postgres error. Asserting
 * on the wrapper's message would silently pass for *any* query failure — a
 * syntax error would look like a security control working.
 *
 * `databaseErrorMessage` walks to the root cause so a test can assert on what
 * Postgres actually said, and `pgErrorCode` exposes the SQLSTATE, which is the
 * least ambiguous signal of all.
 */

export function rootCause(error: unknown): unknown {
  let current = error;
  const seen = new Set<unknown>();
  while (
    current !== null &&
    typeof current === 'object' &&
    'cause' in current &&
    (current as { cause?: unknown }).cause !== undefined &&
    !seen.has(current)
  ) {
    seen.add(current);
    current = (current as { cause: unknown }).cause;
  }
  return current;
}

/** Full message chain, so a match can hit the wrapper or the driver error. */
export function databaseErrorMessage(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();

  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const message = (current as { message?: unknown }).message;
    if (typeof message === 'string') parts.push(message);
    current = (current as { cause?: unknown }).cause;
  }

  if (typeof current === 'string') parts.push(current);
  return parts.join(' | ');
}

/** SQLSTATE of the underlying Postgres error, when there is one. */
export function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();

  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Runs `fn`, expecting a rejection, and returns the thrown value. */
export async function captureRejection(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the operation to reject, but it resolved.');
}
