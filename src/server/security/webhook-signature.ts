import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { env } from '@/server/config/env';

/**
 * Inbound webhook authentication (§28).
 *
 * n8n callbacks are authenticated with an HMAC-SHA256 signature over a
 * canonical string, carrying a timestamp and a nonce:
 *
 *   X-AIW-Signature: t=<unix-seconds>,n=<nonce>,v1=<hex-hmac>
 *
 * Signed value: `${timestamp}.${nonce}.${rawBody}`
 *
 * Four properties, each defending something different:
 *
 *  - The HMAC proves the sender holds the shared secret.
 *  - The timestamp bounds how long a captured request stays useful.
 *  - The nonce, recorded in webhook_deliveries with a unique index, makes replay
 *    inside that window fail on the second attempt.
 *  - Comparison is constant-time, so the signature cannot be recovered a byte
 *    at a time by timing the response.
 *
 * Rotation: N8N_CALLBACK_SECRETS is an ordered list. Index 0 signs; every entry
 * verifies. Rolling a secret means prepending the new one, deploying, updating
 * n8n, then dropping the old one — with no window where callbacks fail.
 */

export const SIGNATURE_HEADER = 'x-aiw-signature';

/** How far a callback's timestamp may drift before it is refused. */
export const MAX_CLOCK_SKEW_SECONDS = 300;

export interface ParsedSignature {
  timestamp: number;
  nonce: string;
  signature: string;
}

export type VerificationFailure =
  | 'missing_header'
  | 'malformed_header'
  | 'no_secret_configured'
  | 'timestamp_out_of_range'
  | 'signature_mismatch';

export type VerificationResult =
  | { ok: true; parsed: ParsedSignature }
  | { ok: false; reason: VerificationFailure };

/** Parses `t=…,n=…,v1=…` into its parts, order-independent. */
export function parseSignatureHeader(header: string | null): ParsedSignature | null {
  if (!header) return null;

  const parts = header.split(',').map((p) => p.trim());
  let timestamp: number | undefined;
  let nonce: string | undefined;
  let signature: string | undefined;

  for (const part of parts) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);

    if (key === 't') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) timestamp = parsed;
    } else if (key === 'n') {
      nonce = value;
    } else if (key === 'v1') {
      signature = value;
    }
  }

  if (timestamp === undefined || !nonce || !signature) return null;
  // A nonce must be long enough that collisions cannot be provoked, and short
  // enough that it cannot be used to bloat the deliveries table.
  if (nonce.length < 8 || nonce.length > 128) return null;
  if (!/^[0-9a-f]+$/i.test(signature)) return null;

  return { timestamp, nonce, signature };
}

function canonicalString(timestamp: number, nonce: string, rawBody: string): string {
  return `${timestamp}.${nonce}.${rawBody}`;
}

export function computeSignature(
  secret: string,
  timestamp: number,
  nonce: string,
  rawBody: string,
): string {
  return createHmac('sha256', secret)
    .update(canonicalString(timestamp, nonce, rawBody), 'utf8')
    .digest('hex');
}

/** Length-safe constant-time hex comparison. */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Verifies a callback.
 *
 * `rawBody` must be the exact bytes received. Re-serializing parsed JSON
 * changes key order and whitespace and breaks every signature, so the route
 * reads the body as text and hands the same string to both this function and
 * the JSON parser.
 */
export function verifyWebhookSignature(
  header: string | null,
  rawBody: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): VerificationResult {
  if (!header) return { ok: false, reason: 'missing_header' };

  const parsed = parseSignatureHeader(header);
  if (!parsed) return { ok: false, reason: 'malformed_header' };

  const secrets = env().N8N_CALLBACK_SECRETS;
  // Fail closed: with no secret configured, nothing is trusted.
  if (secrets.length === 0) return { ok: false, reason: 'no_secret_configured' };

  // Reject stale AND future-dated timestamps; a far-future value would
  // otherwise stay valid indefinitely.
  const skew = Math.abs(nowSeconds - parsed.timestamp);
  if (skew > MAX_CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: 'timestamp_out_of_range' };
  }

  // Every candidate secret is tried without short-circuiting, so the number of
  // HMACs computed does not reveal which secret matched.
  let matched = false;
  for (const secret of secrets) {
    const expected = computeSignature(secret, parsed.timestamp, parsed.nonce, rawBody);
    if (constantTimeEquals(expected, parsed.signature)) matched = true;
  }

  if (!matched) return { ok: false, reason: 'signature_mismatch' };
  return { ok: true, parsed };
}

/**
 * Signs an outbound payload with the current primary secret.
 *
 * Used by the test suite and by any future SaaS→n8n call that needs to prove
 * its origin.
 */
export function signPayload(rawBody: string): {
  header: string;
  timestamp: number;
  nonce: string;
} {
  const secrets = env().N8N_CALLBACK_SECRETS;
  const secret = secrets[0];
  if (!secret) {
    throw new Error('No callback secret configured; cannot sign.');
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(16).toString('hex');
  const signature = computeSignature(secret, timestamp, nonce, rawBody);

  return {
    header: `t=${timestamp},n=${nonce},v1=${signature}`,
    timestamp,
    nonce,
  };
}
