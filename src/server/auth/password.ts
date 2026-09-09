import { scrypt, randomBytes, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * `promisify` cannot see through scrypt's overloads, so the options-carrying
 * signature is restated here. Without it the cost parameters below would be
 * dropped at the call site and every hash would silently use Node's defaults.
 */
const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * Password hashing.
 *
 * scrypt from node:crypto, at OWASP's recommended parameters (N=2^17, r=8,
 * p=1). Chosen over argon2id because argon2 requires a native addon, and a
 * native build failure at deploy time is a worse outcome than the modest
 * margin argon2id holds over well-parameterised scrypt. The encoded format
 * carries its own parameters, so raising the cost later verifies old hashes
 * correctly and `needsRehash` tells the login path to upgrade them in place.
 *
 * Encoded form: scrypt$N$r$p$<salt-b64>$<hash-b64>
 */

const CURRENT = {
  N: 2 ** 17, // 131072 — ~130 MB of memory per hash
  r: 8,
  p: 1,
  keyLength: 64,
  saltBytes: 16,
} as const;

// scrypt's memory use is roughly 128 * N * r bytes. Node's default 32 MB
// buffer limit is far below what N=2^17 needs, so it must be raised explicitly.
const MAX_MEMORY = 256 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(CURRENT.saltBytes);
  const derived = (await scryptAsync(
    password.normalize('NFKC'),
    salt,
    CURRENT.keyLength,
    { N: CURRENT.N, r: CURRENT.r, p: CURRENT.p, maxmem: MAX_MEMORY },
  )) as Buffer;

  return [
    'scrypt',
    CURRENT.N,
    CURRENT.r,
    CURRENT.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parse(encoded: string): ParsedHash | null {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;

  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);

  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  // Refuse absurd parameters from a tampered row rather than trying to honour
  // them and stalling the event loop.
  if (N < 2 ** 14 || N > 2 ** 20 || r < 1 || r > 32 || p < 1 || p > 16) return null;

  try {
    return {
      N,
      r,
      p,
      salt: Buffer.from(saltRaw ?? '', 'base64'),
      hash: Buffer.from(hashRaw ?? '', 'base64'),
    };
  } catch {
    return null;
  }
}

export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const parsed = parse(encoded);
  if (!parsed) return false;

  const derived = (await scryptAsync(
    password.normalize('NFKC'),
    parsed.salt,
    parsed.hash.length,
    { N: parsed.N, r: parsed.r, p: parsed.p, maxmem: MAX_MEMORY },
  )) as Buffer;

  // Length check first: timingSafeEqual throws on mismatched lengths.
  if (derived.length !== parsed.hash.length) return false;
  return timingSafeEqual(derived, parsed.hash);
}

/** True when `encoded` was produced with weaker parameters than we now use. */
export function needsRehash(encoded: string): boolean {
  const parsed = parse(encoded);
  if (!parsed) return true;
  return parsed.N < CURRENT.N || parsed.r < CURRENT.r || parsed.p < CURRENT.p;
}

/**
 * Burns roughly the same CPU as a real verification.
 *
 * Login calls this when the email does not exist, so that "no such user" and
 * "wrong password" take indistinguishable time. Without it, response latency
 * is a user-enumeration oracle.
 */
export async function fakeVerify(): Promise<void> {
  await scryptAsync('decoy', randomBytes(CURRENT.saltBytes), CURRENT.keyLength, {
    N: CURRENT.N,
    r: CURRENT.r,
    p: CURRENT.p,
    maxmem: MAX_MEMORY,
  });
}

/**
 * Password policy (§11).
 *
 * Length over composition rules, following NIST SP 800-63B: a 12-character
 * minimum with no forced character classes, plus a block list for the
 * predictable choices. Returns i18n rule keys, never English prose.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '123456789012', 'qwertyuiop',
  'administrator', 'letmein12345', 'welcome12345', 'iloveyou1234',
  'aaaaaaaaaaaa', '111111111111', 'passw0rd1234',
]);

export function validatePasswordStrength(password: string): string[] {
  const failures: string[] = [];

  if (password.length < PASSWORD_MIN_LENGTH) failures.push('too_short');
  if (password.length > PASSWORD_MAX_LENGTH) failures.push('too_long');
  if (COMMON_PASSWORDS.has(password.toLowerCase())) failures.push('too_common');
  // A password of one repeated character passes a naive length check.
  if (password.length > 0 && new Set(password).size < 4) failures.push('too_simple');

  return failures;
}
