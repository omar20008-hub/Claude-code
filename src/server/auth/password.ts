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
 * minimum with no forced character classes, and no mandatory rotation. NIST's
 * accompanying requirement is the part that is usually skipped — screening
 * against known-weak choices — so that is what the checks below do.
 *
 * An exact-match block list is not enough. "password1234" is twelve characters
 * of distinct-enough content and would sail past a naive check while being
 * among the first guesses any attacker makes. So the screening is structural:
 * strip the predictable padding people add to a weak base word, and judge what
 * is left.
 *
 * Returns i18n rule keys, never English prose.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

/**
 * Weak base words. Kept deliberately short: it lists *stems*, and the
 * normalisation below strips the digits, years, punctuation and leetspeak that
 * turn a stem into the thousands of variants a real breach corpus contains.
 */
const WEAK_BASES = [
  'password', 'passwd', 'pass', 'secret', 'letmein', 'welcome', 'admin',
  'administrator', 'root', 'login', 'user', 'guest', 'test', 'demo',
  'qwerty', 'qwertyuiop', 'asdf', 'asdfgh', 'zxcvbn', 'azerty',
  'iloveyou', 'monkey', 'dragon', 'sunshine', 'princess', 'football',
  'baseball', 'superman', 'trustno', 'master', 'shadow', 'michael',
  'abc', 'changeme', 'default', 'temporary', 'temp',
  // Arabic-keyboard and transliterated equivalents seen in regional corpora.
  'marhaba', 'ahlan', 'habibi', 'salam', 'allah', 'riyadh', 'saudi',
];

/** Common leetspeak substitutions, reversed so `p@ssw0rd` reduces to `password`. */
const LEET: Record<string, string> = {
  '@': 'a', '4': 'a', '8': 'b', '(': 'c', '3': 'e', '6': 'g',
  '1': 'i', '!': 'i', '|': 'i', '0': 'o', '5': 's', '$': 's', '7': 't', '+': 't',
};

/**
 * Produces the alphabetic forms a weak base could be hiding in.
 *
 * Two candidates, because one normalisation cannot catch both tricks:
 *
 *  - Strip non-letters only. "password1234" -> "password". Trailing digits are
 *    padding and should simply vanish.
 *  - Apply leetspeak first, then strip. "p@ssw0rd" -> "password". Here the
 *    digits stand in for letters and must be translated, not dropped.
 *
 * Doing leet substitution before stripping in a single pass gets the first case
 * wrong: it turns "password1234" into "passwordiea", which matches nothing.
 */
function screeningCandidates(password: string): string[] {
  const lowered = password.toLowerCase();

  const lettersOnly = lowered.replace(/[^a-z]/g, '');
  const leetTranslated = lowered
    .split('')
    .map((char) => LEET[char] ?? char)
    .join('')
    .replace(/[^a-z]/g, '');

  return [...new Set([lettersOnly, leetTranslated])].filter((candidate) => candidate.length > 0);
}

/**
 * True when a weak base word accounts for most of a candidate's alphabetic
 * content. A ratio test rather than an exact match, so "Password2026" is caught
 * while "toastmaster-recipe-2026" — which merely contains "master" — is not.
 */
const WEAK_BASE_DOMINANCE = 0.6;

function containsDominantWeakBase(candidate: string): boolean {
  for (const base of WEAK_BASES) {
    if (base.length < 3) continue;
    if (!candidate.includes(base)) continue;
    if (base.length / candidate.length >= WEAK_BASE_DOMINANCE) return true;
  }
  return false;
}

/** True when the string is one long run of ascending or descending characters. */
function isSequentialRun(value: string): boolean {
  if (value.length < 4) return false;
  let ascending = true;
  let descending = true;

  for (let i = 1; i < value.length; i += 1) {
    const delta = value.charCodeAt(i) - value.charCodeAt(i - 1);
    if (delta !== 1) ascending = false;
    if (delta !== -1) descending = false;
    if (!ascending && !descending) return false;
  }
  return ascending || descending;
}

/** True when the whole string is a short block repeated (e.g. "abcabcabcabc"). */
function isRepeatedBlock(value: string): boolean {
  for (let size = 1; size <= Math.floor(value.length / 2); size += 1) {
    if (value.length % size !== 0) continue;
    const block = value.slice(0, size);
    if (block.repeat(value.length / size) === value) return true;
  }
  return false;
}

export function validatePasswordStrength(password: string): string[] {
  const failures: string[] = [];

  if (password.length < PASSWORD_MIN_LENGTH) failures.push('too_short');
  if (password.length > PASSWORD_MAX_LENGTH) failures.push('too_long');

  // Nothing further is meaningful for an empty or over-long value.
  if (password.length === 0 || password.length > PASSWORD_MAX_LENGTH) return failures;

  // A password whose alphabetic core IS a weak base, or a weak base plus
  // padding that contributes nothing (digits, a year, punctuation, leetspeak).
  if (screeningCandidates(password).some(containsDominantWeakBase)) {
    failures.push('too_common');
  }

  // Structural weakness, independent of any word list.
  const lowered = password.toLowerCase();
  if (
    new Set(password).size < 5 ||
    isSequentialRun(lowered) ||
    isRepeatedBlock(lowered) ||
    // All digits, however long: "123456789012" or a phone number.
    /^\d+$/.test(password)
  ) {
    failures.push('too_simple');
  }

  return [...new Set(failures)];
}
