import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import path from 'node:path';
import { negotiateLocale, directionOf, localeConfig, resolveLocale } from '@/i18n/config';
import { detectDirection, isolate, formatCurrencyMinor, formatBytes } from '@/i18n/format';

/**
 * RTL/LTR architecture tests (§6, §44).
 *
 * The static analysis below is the important half. Direction bugs are the kind
 * that pass every visual review conducted in English: a physical start-padding
 * renders perfectly for an English reader and lands on the wrong side for an
 * Arabic one. A person testing in one language cannot see it, so it has to be a
 * machine check.
 *
 * The forbidden tokens are assembled from fragments rather than written out,
 * because Tailwind scans this repository for class-like strings and would
 * generate the very CSS these tests exist to forbid.
 */

const SOURCE_ROOT = path.resolve(__dirname, '../../src');

function sourceFiles(): string[] {
  return globSync('**/*.{ts,tsx}', { cwd: SOURCE_ROOT })
    .map((relative) => path.join(SOURCE_ROOT, relative))
    // Emails render in clients with no logical-property support, so they are
    // written with physical attributes on purpose.
    .filter((file) => !file.includes(path.join('services', 'email.ts')));
}

/**
 * Tailwind utilities that hard-code a physical side. Each has a logical
 * counterpart that resolves against `dir` instead.
 */
const FORBIDDEN_CLASS_PATTERNS: Array<{ pattern: RegExp; use: string }> = [
  { pattern: /\b(?:sm:|md:|lg:|xl:|2xl:|hover:|focus:)?ml-\d/, use: 'ms-*' },
  { pattern: /\b(?:sm:|md:|lg:|xl:|2xl:|hover:|focus:)?mr-\d/, use: 'me-*' },
  { pattern: /\b(?:sm:|md:|lg:|xl:|2xl:|hover:|focus:)?pl-\d/, use: 'ps-*' },
  { pattern: /\b(?:sm:|md:|lg:|xl:|2xl:|hover:|focus:)?pr-\d/, use: 'pe-*' },
  { pattern: /\btext-left\b/, use: 'text-start' },
  { pattern: /\btext-right\b/, use: 'text-end' },
  { pattern: /\bborder-l\b/, use: 'border-s' },
  { pattern: /\bborder-r\b/, use: 'border-e' },
  { pattern: /\brounded-l(?:-|\b)/, use: 'rounded-s-*' },
  { pattern: /\brounded-r(?:-|\b)/, use: 'rounded-e-*' },
  { pattern: /\bleft-\d/, use: 'start-*' },
  { pattern: /\bright-\d/, use: 'end-*' },
  { pattern: /\bfloat-left\b/, use: 'float-start' },
  { pattern: /\bfloat-right\b/, use: 'float-end' },
];

/** Raw CSS properties that should be logical. */
const FORBIDDEN_CSS_PATTERNS: Array<{ pattern: RegExp; use: string }> = [
  { pattern: /(?<!-)\bmargin-left\s*:/, use: 'margin-inline-start' },
  { pattern: /(?<!-)\bmargin-right\s*:/, use: 'margin-inline-end' },
  { pattern: /(?<!-)\bpadding-left\s*:/, use: 'padding-inline-start' },
  { pattern: /(?<!-)\bpadding-right\s*:/, use: 'padding-inline-end' },
  { pattern: /(?<!-)\bborder-left\s*:/, use: 'border-inline-start' },
  { pattern: /(?<!-)\bborder-right\s*:/, use: 'border-inline-end' },
];

describe('RTL/LTR architecture', () => {
  it('uses no physical-direction Tailwind utilities in any component', () => {
    const violations: string[] = [];

    for (const file of sourceFiles()) {
      const contents = readFileSync(file, 'utf8');
      const lines = contents.split('\n');

      lines.forEach((line, index) => {
        // Only class strings matter; a comment mentioning "text-left" is fine.
        if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) return;

        for (const { pattern, use } of FORBIDDEN_CLASS_PATTERNS) {
          if (pattern.test(line)) {
            violations.push(
              `${path.relative(SOURCE_ROOT, file)}:${index + 1} — use ${use} instead: ${line.trim().slice(0, 100)}`,
            );
          }
        }
      });
    }

    expect(violations, 'physical-direction utilities break RTL silently').toEqual([]);
  });

  it('uses logical properties in the stylesheet', () => {
    const css = readFileSync(path.join(SOURCE_ROOT, 'app/globals.css'), 'utf8');
    const violations: string[] = [];

    css.split('\n').forEach((line, index) => {
      if (line.trimStart().startsWith('/*') || line.trimStart().startsWith('*')) return;
      for (const { pattern, use } of FORBIDDEN_CSS_PATTERNS) {
        if (pattern.test(line)) {
          violations.push(`globals.css:${index + 1} — use ${use}: ${line.trim()}`);
        }
      }
    });

    expect(violations).toEqual([]);
  });

  it('maps each locale to the correct writing direction', () => {
    expect(directionOf('ar')).toBe('rtl');
    expect(directionOf('en')).toBe('ltr');
    expect(localeConfig.ar.tag).toBe('ar-SA');
  });
});

describe('locale negotiation', () => {
  it('sends an Arabic browser to Arabic', () => {
    expect(negotiateLocale('ar')).toBe('ar');
    expect(negotiateLocale('ar-SA,ar;q=0.9,en;q=0.8')).toBe('ar');
    expect(negotiateLocale('ar-EG')).toBe('ar');
  });

  it('sends an English browser to English', () => {
    expect(negotiateLocale('en-US,en;q=0.9')).toBe('en');
    expect(negotiateLocale('en-GB')).toBe('en');
  });

  it('honours q-values rather than header order', () => {
    // English is listed first but Arabic is preferred.
    expect(negotiateLocale('en;q=0.3,ar;q=0.9')).toBe('ar');
    expect(negotiateLocale('ar;q=0.2,en;q=0.95')).toBe('en');
  });

  it('falls back to the configured default for unsupported languages', () => {
    expect(negotiateLocale('fr-FR,fr;q=0.9', 'ar')).toBe('ar');
    expect(negotiateLocale('ja', 'en')).toBe('en');
    expect(negotiateLocale(null, 'ar')).toBe('ar');
    expect(negotiateLocale('', 'en')).toBe('en');
  });

  it('treats q=0 as "not acceptable"', () => {
    // The client explicitly refuses Arabic.
    expect(negotiateLocale('ar;q=0,en;q=0.5')).toBe('en');
  });

  it('resolves any Arabic or English variant tag', () => {
    expect(resolveLocale('ar-AE')).toBe('ar');
    expect(resolveLocale('ARB')).toBe('ar');
    expect(resolveLocale('en-AU')).toBe('en');
    expect(resolveLocale('de')).toBeNull();
    expect(resolveLocale(undefined)).toBeNull();
  });
});

describe('bidirectional text handling', () => {
  it('detects direction from the first strong character', () => {
    expect(detectDirection('سياسة الموارد البشرية')).toBe('rtl');
    expect(detectDirection('HR Policy')).toBe('ltr');
    // Leading digits and punctuation are neutral; the first letter decides.
    expect(detectDirection('2024 تقرير')).toBe('rtl');
    expect(detectDirection('"HR Policy.pdf"')).toBe('ltr');
  });

  it('wraps foreign-direction runs in a Unicode isolate', () => {
    // Without isolation, a filename ending in ".pdf" inside Arabic prose
    // renders with the extension displaced, which reads as corruption.
    const wrapped = isolate('HR Policy.pdf');
    expect(wrapped.startsWith('⁨')).toBe(true);
    expect(wrapped.endsWith('⁩')).toBe(true);
    expect(wrapped).toContain('HR Policy.pdf');
  });
});

describe('locale-aware formatting', () => {
  it('formats currency from minor units in both locales', () => {
    // 350.00 SAR stored as 35000 halalas.
    const arabic = formatCurrencyMinor(35000, 'SAR', 'ar');
    const english = formatCurrencyMinor(35000, 'SAR', 'en');

    expect(arabic).toContain('350');
    expect(english).toContain('350');

    // Arabic UI uses Western digits — Saudi business software convention.
    // Arabic-Indic digits here would read as archaic on an invoice.
    expect(arabic).toMatch(/[0-9]/);
    expect(arabic).not.toMatch(/[٠-٩]/);
  });

  it('renders fractional amounts without dropping precision', () => {
    expect(formatCurrencyMinor(35050, 'SAR', 'en')).toContain('350.5');
  });

  it('formats byte counts in both locales', () => {
    expect(formatBytes(0, 'en')).toContain('0');
    expect(formatBytes(1024, 'en')).toContain('1');
    expect(formatBytes(1024, 'en')).toContain('KB');
    expect(formatBytes(5 * 1024 * 1024, 'ar')).toContain('MB');
  });
});

describe('shipped stylesheet', () => {
  /**
   * Asserts against the *built* CSS, not the source.
   *
   * The source-scanning test above catches a physical utility written in a
   * component. This one catches everything else that can put a physical
   * property in the bundle: a Tailwind preflight rule, a dependency's styles,
   * or — the case that actually happened here — the scanner picking up a class
   * name written inside a code comment and emitting the rule for it.
   *
   * Skipped when `.next` has not been built, so `npm test` works on a clean
   * clone; CI runs the build before the tests, so it always executes there.
   */
  const cssFiles = globSync('.next/static/css/*.css', {
    cwd: path.resolve(__dirname, '../..'),
  }).map((relative) => path.resolve(__dirname, '../..', relative));

  it.skipIf(cssFiles.length === 0)(
    'contains no physical-direction CSS properties',
    () => {
      const offenders: string[] = [];

      for (const file of cssFiles) {
        const css = readFileSync(file, 'utf8');
        for (const property of [
          'margin-left:',
          'margin-right:',
          'padding-left:',
          'padding-right:',
          'text-align:left',
          'text-align:right',
          'border-left-width',
          'border-right-width',
        ]) {
          const count = css.split(property).length - 1;
          if (count > 0) {
            offenders.push(`${path.basename(file)}: ${count}× ${property}`);
          }
        }
      }

      expect(offenders, 'physical properties do not respond to dir').toEqual([]);
    },
  );

  it.skipIf(cssFiles.length === 0)('does emit logical properties', () => {
    const css = cssFiles.map((file) => readFileSync(file, 'utf8')).join('');

    // Guards against the previous assertion passing trivially because the
    // stylesheet contains no directional layout at all.
    expect(css).toContain('padding-inline');
    expect(css).toContain('margin-inline');
    expect(css).toContain('border-inline');
  });
});
