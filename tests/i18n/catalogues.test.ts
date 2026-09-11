import { describe, it, expect } from 'vitest';
import IntlMessageFormat from 'intl-messageformat';
import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import en from '../../messages/en.json';
import ar from '../../messages/ar.json';
import { locales, localeConfig } from '@/i18n/config';

/**
 * Internationalization test suite (§45).
 *
 * These are not cosmetic checks. Each one closes a failure mode that ships
 * silently otherwise:
 *
 *  - A key present in English but missing in Arabic renders as `some.key.path`
 *    to an Arabic user.
 *  - An argument named `{count}` in English but `{عدد}` in Arabic throws at
 *    render time, taking the page down for one language only.
 *  - Arabic has six plural categories. A catalogue that only supplies `one`
 *    and `other` produces grammatically wrong output for 3, 11 and 100.
 */

type Catalogue = Record<string, unknown>;

function flatten(obj: Catalogue, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flatten(value as Catalogue, path));
    } else {
      out[path] = String(value);
    }
  }
  return out;
}

const flatEn = flatten(en as Catalogue);
const flatAr = flatten(ar as Catalogue);

/**
 * Collects the *argument names* an ICU message references, walking the parsed
 * AST rather than pattern-matching braces. A regex cannot tell `{count}` (an
 * argument) from `{No other sessions}` (literal text inside a plural branch),
 * which is exactly the distinction that matters here.
 */
function argumentNames(message: string): Set<string> {
  const names = new Set<string>();

  const walk = (elements: MessageFormatElement[]): void => {
    for (const element of elements) {
      switch (element.type) {
        case TYPE.argument:
        case TYPE.number:
        case TYPE.date:
        case TYPE.time:
          names.add(element.value);
          break;
        case TYPE.select:
        case TYPE.plural:
          names.add(element.value);
          for (const option of Object.values(element.options)) {
            walk(option.value);
          }
          break;
        case TYPE.tag:
          walk(element.children);
          break;
        default:
          break;
      }
    }
  };

  walk(parse(message));
  return names;
}

/** Plural categories a locale's grammar actually distinguishes. */
function requiredPluralCategories(locale: string): string[] {
  const rules = new Intl.PluralRules(locale);
  return rules.resolvedOptions().pluralCategories;
}

describe('message catalogues', () => {
  it('defines a catalogue for every supported locale', () => {
    expect(locales).toEqual(['ar', 'en']);
  });

  it('has identical key sets in every locale', () => {
    const enKeys = Object.keys(flatEn).sort();
    const arKeys = Object.keys(flatAr).sort();

    const missingInArabic = enKeys.filter((k) => !(k in flatAr));
    const missingInEnglish = arKeys.filter((k) => !(k in flatEn));

    expect(missingInArabic, 'keys missing from ar.json').toEqual([]);
    expect(missingInEnglish, 'keys missing from en.json').toEqual([]);
  });

  it('has no empty or placeholder-only values', () => {
    const offenders: string[] = [];
    for (const [catalogue, flat] of [
      ['en', flatEn],
      ['ar', flatAr],
    ] as const) {
      for (const [key, value] of Object.entries(flat)) {
        if (value.trim().length === 0) offenders.push(`${catalogue}:${key} is empty`);
        if (/^(TODO|FIXME|XXX)\b/i.test(value.trim())) {
          offenders.push(`${catalogue}:${key} is a placeholder`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('compiles every message as valid ICU in its own locale', () => {
    const failures: string[] = [];

    for (const [locale, flat] of [
      ['en', flatEn],
      ['ar', flatAr],
    ] as const) {
      const tag = localeConfig[locale].tag;
      for (const [key, message] of Object.entries(flat)) {
        try {
          new IntlMessageFormat(message, tag);
        } catch (error) {
          failures.push(`${locale}:${key} — ${(error as Error).message}`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it('uses the same argument names across locales', () => {
    const mismatches: string[] = [];

    for (const key of Object.keys(flatEn)) {
      const arMessage = flatAr[key];
      if (arMessage === undefined) continue;

      const enArgs = argumentNames(flatEn[key] as string);
      const arArgs = argumentNames(arMessage);

      const onlyEn = [...enArgs].filter((a) => !arArgs.has(a));
      const onlyAr = [...arArgs].filter((a) => !enArgs.has(a));

      if (onlyEn.length > 0 || onlyAr.length > 0) {
        mismatches.push(
          `${key} — en-only: [${onlyEn.join(', ')}], ar-only: [${onlyAr.join(', ')}]`,
        );
      }
    }

    expect(mismatches).toEqual([]);
  });

  it('covers every plural category the language actually distinguishes', () => {
    // Arabic: zero, one, two, few, many, other. English: one, other.
    const gaps: string[] = [];

    for (const [locale, flat] of [
      ['en', flatEn],
      ['ar', flatAr],
    ] as const) {
      const tag = localeConfig[locale].tag;
      const required = requiredPluralCategories(tag);

      for (const [key, message] of Object.entries(flat)) {
        let elements: MessageFormatElement[];
        try {
          elements = parse(message);
        } catch {
          continue; // reported by the ICU compile test
        }

        const checkPlurals = (nodes: MessageFormatElement[]): void => {
          for (const node of nodes) {
            if (node.type === TYPE.plural) {
              const provided = Object.keys(node.options);
              // An `=0`/`=1` exact match legitimately substitutes for a
              // category, so only flag a category with neither form present.
              const missing = required.filter(
                (category) => !provided.includes(category) && !provided.includes(`=${category}`),
              );
              if (missing.length > 0) {
                gaps.push(`${locale}:${key} — missing plural categories: ${missing.join(', ')}`);
              }
              for (const option of Object.values(node.options)) checkPlurals(option.value);
            } else if (node.type === TYPE.select) {
              for (const option of Object.values(node.options)) checkPlurals(option.value);
            } else if (node.type === TYPE.tag) {
              checkPlurals(node.children);
            }
          }
        };

        checkPlurals(elements);
      }
    }

    expect(gaps).toEqual([]);
  });

  it('renders plural messages correctly across Arabic plural boundaries', () => {
    // Arabic distinguishes 0, 1, 2, 3-10 (few), 11-99 (many), 100+ (other).
    // Rendering must differ between those bands, not just between 1 and n.
    const message = flatAr['notifications.unreadCount'];
    expect(message).toBeDefined();

    const formatter = new IntlMessageFormat(message as string, 'ar-SA');
    const rendered = [0, 1, 2, 3, 11, 100].map((count) =>
      String(formatter.format({ count })),
    );

    // Every band produces a distinct string; none falls through to a stray key.
    expect(new Set(rendered).size).toBe(6);
    expect(rendered[0]).toContain('لا إشعارات');
    expect(rendered[1]).toContain('واحد');
    expect(rendered[2]).toContain('إشعاران');
  });

  it('contains no Latin-script UI prose in the Arabic catalogue', () => {
    // Product names (Meta, Google Drive, n8n, PDF, CSV) legitimately stay in
    // Latin script. What must not appear is an untranslated English sentence.
    const allowed =
      /^(Meta|Google Drive|Google|Drive|n8n|PDF|DOC|DOCX|CSV|S3|API|Graph API|Enter|Shift|TikTok|Veo|https?:\/\/\S+|[\p{P}\p{S}\d\s]+)$/u;

    const suspicious: string[] = [];
    for (const [key, value] of Object.entries(flatAr)) {
      // Strip ICU syntax, Arabic text, digits and punctuation; what remains is
      // Latin prose.
      const latinRuns = value.match(/[A-Za-z][A-Za-z'’-]*(?:\s+[A-Za-z][A-Za-z'’-]*)*/g) ?? [];
      for (const run of latinRuns) {
        const words = run.trim().split(/\s+/);
        // Three or more consecutive Latin words that are not a known product
        // name reads as untranslated English.
        if (words.length >= 3 && !allowed.test(run.trim())) {
          suspicious.push(`${key}: "${run.trim()}"`);
        }
      }
    }

    expect(suspicious).toEqual([]);
  });

  it('contains no key whose own name has a dot in it', () => {
    /*
     * next-intl resolves `t('actions.auth.login')` by SPLITTING on dots and
     * walking the object. A catalogue entry literally named "auth.login" is a
     * different thing entirely, and the lookup misses it — the page then renders
     * the raw key path to the user.
     *
     * This shipped: activity.actions held 26 flat keys like "auth.login", and
     * the whole Activity page showed key paths instead of action names in both
     * languages. Neither catalogue test caught it, because they flatten with
     * dots and so cannot tell a dotted key from a nested path; the usage test
     * had the same blind spot. It surfaced only as a MISSING_MESSAGE line in
     * the server log during an end-to-end run.
     *
     * Walking the raw objects, rather than a flattened view, is what makes the
     * distinction visible.
     */
    const offenders: string[] = [];

    const walk = (node: Catalogue, path: string, locale: string): void => {
      for (const [key, value] of Object.entries(node)) {
        if (key.includes('.')) {
          offenders.push(`${locale}: "${key}" at ${path || '(root)'}`);
        }
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          walk(value as Catalogue, path ? `${path}.${key}` : key, locale);
        }
      }
    };

    walk(en as Catalogue, '', 'en');
    walk(ar as Catalogue, '', 'ar');

    expect(offenders, 'dotted key names are unreachable through dot-path lookup').toEqual([]);
  });

  it('keeps every locale directional metadata consistent', () => {
    expect(localeConfig.ar.direction).toBe('rtl');
    expect(localeConfig.en.direction).toBe('ltr');
    expect(localeConfig.ar.tag).toBe('ar-SA');
    expect(localeConfig.en.tag).toBe('en-US');
  });
});
