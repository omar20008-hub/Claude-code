import { describe, it, expect } from 'vitest';
import {
  verifyWebhookSignature,
  signPayload,
  computeSignature,
  parseSignatureHeader,
  MAX_CLOCK_SKEW_SECONDS,
} from '@/server/security/webhook-signature';
import { resetEnvCache } from '@/server/config/env';

/**
 * Webhook authentication (§28, §50).
 *
 * Each test below corresponds to one attack the design is meant to stop, and
 * each is written from the attacker's side: what would they send, and does it
 * get in?
 */

const SECRET = process.env.N8N_CALLBACK_SECRETS!;
const BODY = JSON.stringify({ requestId: 'req_abc', event: 'agent.completed' });

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

describe('signature header parsing', () => {
  it('parses the documented header format', () => {
    const parsed = parseSignatureHeader('t=1700000000,n=abcdef0123456789,v1=deadbeef');
    expect(parsed).toEqual({
      timestamp: 1700000000,
      nonce: 'abcdef0123456789',
      signature: 'deadbeef',
    });
  });

  it('accepts the fields in any order', () => {
    const parsed = parseSignatureHeader('v1=deadbeef,t=1700000000,n=abcdef0123456789');
    expect(parsed?.signature).toBe('deadbeef');
  });

  it('rejects malformed or incomplete headers', () => {
    for (const header of [
      null,
      '',
      'garbage',
      't=1700000000',
      'n=abcdef0123456789,v1=deadbeef',
      't=notanumber,n=abcdef0123456789,v1=deadbeef',
      // A nonce too short to be collision-resistant.
      't=1700000000,n=abc,v1=deadbeef',
      // A non-hex signature.
      't=1700000000,n=abcdef0123456789,v1=zzzz',
    ]) {
      expect(parseSignatureHeader(header), String(header)).toBeNull();
    }
  });

  it('rejects a nonce long enough to bloat the deliveries table', () => {
    expect(parseSignatureHeader(`t=1,n=${'a'.repeat(200)},v1=ab`)).toBeNull();
  });
});

describe('signature verification', () => {
  it('accepts a correctly signed payload', () => {
    const { header } = signPayload(BODY);
    const result = verifyWebhookSignature(header, BODY);
    expect(result.ok).toBe(true);
  });

  it('rejects a request with no signature at all', () => {
    const result = verifyWebhookSignature(null, BODY);
    expect(result).toEqual({ ok: false, reason: 'missing_header' });
  });

  it('rejects a forged signature', () => {
    const header = `t=${nowSeconds()},n=abcdef0123456789,v1=${'0'.repeat(64)}`;
    const result = verifyWebhookSignature(header, BODY);
    expect(result).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('rejects a valid signature over a DIFFERENT body', () => {
    // The core tampering case: an attacker replays a captured signature with
    // an altered payload — say, changing which campaign is marked completed.
    const { header } = signPayload(BODY);
    const tampered = JSON.stringify({ requestId: 'req_victim', event: 'agent.completed' });

    const result = verifyWebhookSignature(header, tampered);
    expect(result).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('rejects a signature that is valid but stale', () => {
    const staleTimestamp = nowSeconds() - MAX_CLOCK_SKEW_SECONDS - 60;
    const signature = computeSignature(SECRET, staleTimestamp, 'abcdef0123456789', BODY);
    const header = `t=${staleTimestamp},n=abcdef0123456789,v1=${signature}`;

    const result = verifyWebhookSignature(header, BODY);
    expect(result).toEqual({ ok: false, reason: 'timestamp_out_of_range' });
  });

  it('rejects a far-future timestamp', () => {
    // Without an upper bound a future-dated signature stays valid indefinitely,
    // which turns one captured request into a permanent key.
    const futureTimestamp = nowSeconds() + MAX_CLOCK_SKEW_SECONDS + 60;
    const signature = computeSignature(SECRET, futureTimestamp, 'abcdef0123456789', BODY);
    const header = `t=${futureTimestamp},n=abcdef0123456789,v1=${signature}`;

    expect(verifyWebhookSignature(header, BODY)).toEqual({
      ok: false,
      reason: 'timestamp_out_of_range',
    });
  });

  it('accepts a timestamp inside the tolerated skew in both directions', () => {
    for (const offset of [-MAX_CLOCK_SKEW_SECONDS + 5, 0, MAX_CLOCK_SKEW_SECONDS - 5]) {
      const timestamp = nowSeconds() + offset;
      const signature = computeSignature(SECRET, timestamp, 'abcdef0123456789', BODY);
      const header = `t=${timestamp},n=abcdef0123456789,v1=${signature}`;
      expect(verifyWebhookSignature(header, BODY).ok, `offset ${offset}`).toBe(true);
    }
  });

  it('binds the signature to the nonce as well as the body', () => {
    // Swapping the nonce must invalidate the signature; otherwise the replay
    // guard could be defeated by minting a fresh nonce for a captured request.
    const timestamp = nowSeconds();
    const signature = computeSignature(SECRET, timestamp, 'abcdef0123456789', BODY);
    const header = `t=${timestamp},n=1111111111111111,v1=${signature}`;

    expect(verifyWebhookSignature(header, BODY)).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });

  it('fails closed when no secret is configured', () => {
    const original = process.env.N8N_CALLBACK_SECRETS;
    try {
      process.env.N8N_CALLBACK_SECRETS = '';
      resetEnvCache();

      // With no secret there is nothing to verify against, so nothing is
      // trusted — the opposite of skipping the check.
      const result = verifyWebhookSignature(
        `t=${nowSeconds()},n=abcdef0123456789,v1=${'0'.repeat(64)}`,
        BODY,
      );
      expect(result).toEqual({ ok: false, reason: 'no_secret_configured' });
    } finally {
      process.env.N8N_CALLBACK_SECRETS = original;
      resetEnvCache();
    }
  });
});

describe('secret rotation', () => {
  it('accepts a signature made with any configured secret', () => {
    const original = process.env.N8N_CALLBACK_SECRETS;
    const oldSecret = 'old-secret-0123456789abcdef0123456789abcdef';
    const newSecret = 'new-secret-0123456789abcdef0123456789abcdef';

    try {
      // Mid-rotation: the new secret signs, both verify.
      process.env.N8N_CALLBACK_SECRETS = `${newSecret},${oldSecret}`;
      resetEnvCache();

      const timestamp = nowSeconds();
      for (const secret of [oldSecret, newSecret]) {
        const signature = computeSignature(secret, timestamp, 'abcdef0123456789', BODY);
        const header = `t=${timestamp},n=abcdef0123456789,v1=${signature}`;
        expect(verifyWebhookSignature(header, BODY).ok, secret).toBe(true);
      }

      // After the old secret is dropped, its signatures stop working.
      process.env.N8N_CALLBACK_SECRETS = newSecret;
      resetEnvCache();

      const staleSignature = computeSignature(oldSecret, timestamp, 'abcdef0123456789', BODY);
      expect(
        verifyWebhookSignature(
          `t=${timestamp},n=abcdef0123456789,v1=${staleSignature}`,
          BODY,
        ).ok,
      ).toBe(false);
    } finally {
      process.env.N8N_CALLBACK_SECRETS = original;
      resetEnvCache();
    }
  });

  it('signs with the first secret in the list', () => {
    const original = process.env.N8N_CALLBACK_SECRETS;
    const primary = 'primary-secret-0123456789abcdef0123456789ab';
    const secondary = 'secondary-secret-0123456789abcdef012345678';

    try {
      process.env.N8N_CALLBACK_SECRETS = `${primary},${secondary}`;
      resetEnvCache();

      const { header, timestamp, nonce } = signPayload(BODY);
      const expected = computeSignature(primary, timestamp, nonce, BODY);
      expect(header).toContain(expected);
    } finally {
      process.env.N8N_CALLBACK_SECRETS = original;
      resetEnvCache();
    }
  });
});

describe('signature stability', () => {
  it('produces a different signature for a body differing by one byte', () => {
    const timestamp = nowSeconds();
    const a = computeSignature(SECRET, timestamp, 'abcdef0123456789', '{"a":1}');
    const b = computeSignature(SECRET, timestamp, 'abcdef0123456789', '{"a":2}');
    expect(a).not.toBe(b);
  });

  it('is stable for identical inputs', () => {
    const timestamp = nowSeconds();
    expect(computeSignature(SECRET, timestamp, 'n0', BODY)).toBe(
      computeSignature(SECRET, timestamp, 'n0', BODY),
    );
  });

  it('produces a full-length SHA-256 hex digest', () => {
    expect(computeSignature(SECRET, 1, 'n0', BODY)).toMatch(/^[0-9a-f]{64}$/);
  });
});
