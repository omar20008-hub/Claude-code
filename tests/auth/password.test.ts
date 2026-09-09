import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  needsRehash,
  validatePasswordStrength,
  PASSWORD_MIN_LENGTH,
} from '@/server/auth/password';

/**
 * Password hashing and policy (§11, §50).
 */

describe('password hashing', () => {
  it('produces a self-describing encoded hash', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');

    // The parameters travel with the hash, so raising the cost later can still
    // verify old passwords and upgrade them in place.
    expect(hash).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    const [, n, r, p] = hash.split('$');
    expect(Number(n)).toBeGreaterThanOrEqual(2 ** 17);
    expect(Number(r)).toBe(8);
    expect(Number(p)).toBe(1);
  }, 30_000);

  it('verifies the correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');

    expect(await verifyPassword('correct-horse-battery-staple', hash)).toBe(true);
    expect(await verifyPassword('correct-horse-battery-stapl', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  }, 30_000);

  it('salts every hash, so identical passwords hash differently', async () => {
    const [a, b] = await Promise.all([hashPassword('same-password-here'), hashPassword('same-password-here')]);

    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password-here', a)).toBe(true);
    expect(await verifyPassword('same-password-here', b)).toBe(true);
  }, 40_000);

  it('normalises Unicode so an equivalent password still verifies', async () => {
    // The same string in NFC and NFD. A user switching keyboards or platforms
    // must not be locked out by a normalisation difference.
    const composed = 'café-password-2026';
    const decomposed = 'café-password-2026';
    expect(composed).not.toBe(decomposed);

    const hash = await hashPassword(composed);
    expect(await verifyPassword(decomposed, hash)).toBe(true);
  }, 30_000);

  it('rejects a malformed or tampered stored hash rather than throwing', async () => {
    for (const bad of [
      '',
      'not-a-hash',
      'scrypt$abc$8$1$c2FsdA==$aGFzaA==',
      'bcrypt$131072$8$1$c2FsdA==$aGFzaA==',
      // Absurd cost parameters from a tampered row must not stall the process.
      'scrypt$999999999$8$1$c2FsdA==$aGFzaA==',
    ]) {
      expect(await verifyPassword('anything', bad)).toBe(false);
    }
  }, 20_000);

  it('flags hashes weaker than the current parameters for rehash', () => {
    expect(needsRehash('scrypt$16384$8$1$c2FsdA==$aGFzaA==')).toBe(true);
    expect(needsRehash('scrypt$131072$8$1$c2FsdA==$aGFzaA==')).toBe(false);
    expect(needsRehash('garbage')).toBe(true);
  });
});

describe('password policy', () => {
  it('accepts a genuinely strong password', () => {
    for (const good of [
      'correct-horse-battery-staple',
      'Tj7#kLmQ92xZpR',
      'the quick brown fox jumps',
      'كلمة-مرور-قوية-جدا-٢٠٢٦',
    ]) {
      expect(validatePasswordStrength(good), good).toEqual([]);
    }
  });

  it('rejects anything shorter than the minimum', () => {
    expect(validatePasswordStrength('short')).toContain('too_short');
    expect(validatePasswordStrength('a'.repeat(PASSWORD_MIN_LENGTH - 1))).toContain('too_short');
  });

  it('rejects a weak base word padded to reach the length minimum', () => {
    // The case that motivated this policy: twelve characters, varied enough to
    // pass a naive check, and among the first guesses any attacker makes.
    for (const weak of [
      'password1234',
      'Password2026',
      'p@ssw0rd-2026',
      'welcome12345',
      'letmein12345',
      'qwertyuiop12',
      'administrator',
      'iloveyou1234',
    ]) {
      expect(validatePasswordStrength(weak), weak).toContain('too_common');
    }
  });

  it('sees through leetspeak and punctuation padding', () => {
    expect(validatePasswordStrength('P@$$w0rd!2026')).toContain('too_common');
    expect(validatePasswordStrength('4dm1n1str4t0r')).toContain('too_common');
  });

  it('rejects structurally trivial passwords regardless of word lists', () => {
    // A repeated character.
    expect(validatePasswordStrength('aaaaaaaaaaaaaa')).toContain('too_simple');
    // A sequential run.
    expect(validatePasswordStrength('abcdefghijklm')).toContain('too_simple');
    // A repeated block.
    expect(validatePasswordStrength('abcabcabcabc')).toContain('too_simple');
    // All digits, however long.
    expect(validatePasswordStrength('123456789012345')).toContain('too_simple');
    expect(validatePasswordStrength('0555123456789')).toContain('too_simple');
  });

  it('rejects an over-long password rather than paying to hash it', () => {
    // An unbounded password is a cheap way to make the server burn CPU.
    expect(validatePasswordStrength('a'.repeat(300))).toContain('too_long');
  });

  it('returns each failure rule at most once', () => {
    const failures = validatePasswordStrength('aaa');
    expect(failures.length).toBe(new Set(failures).size);
  });
});
