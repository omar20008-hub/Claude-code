import { describe, it, expect } from 'vitest';
import { readFileSync, globSync } from 'node:fs';
import path from 'node:path';
import en from '../../messages/en.json';
import ar from '../../messages/ar.json';

/**
 * Translation-usage analysis (§45).
 *
 * The catalogue tests prove the two languages agree with each other. This one
 * proves the *code* agrees with the catalogues, which is a different failure:
 *
 *   const t = useTranslations('auth.resetPassword');
 *   …
 *   t('backToLogin')            // key lives under auth.forgotPassword
 *
 * Both catalogues are internally consistent, both languages have every key they
 * share — and the reset-password page still renders a raw key path. That bug
 * shipped in this codebase and this test is why it cannot ship again.
 *
 * The extraction is deliberately conservative in two ways, because a false
 * positive here would train people to ignore the test:
 *
 *  - Only calls whose namespace and key are both string literals are resolved.
 *    A dynamic key is counted and skipped rather than guessed at.
 *  - One file may bind the same translator name in several function scopes
 *    (`const t = useTranslations('nav')` in one component and
 *    `const t = useTranslations('common.actions')` in another). A regex cannot
 *    tell those scopes apart, so a name is treated as bound to *every*
 *    namespace it takes in that file, and a key counts as resolved if it exists
 *    under any of them. That gives up a little precision and gives up no
 *    soundness: a key that exists under none of them is still a real bug.
 */

const SOURCE_ROOT = path.resolve(__dirname, '../../src');

type Catalogue = Record<string, unknown>;

function flatten(obj: Catalogue, prefix = ''): Set<string> {
  const keys = new Set<string>();
  for (const [key, value] of Object.entries(obj)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const nested of flatten(value as Catalogue, dotted)) keys.add(nested);
    } else {
      keys.add(dotted);
    }
  }
  return keys;
}

const enKeys = flatten(en as Catalogue);
const arKeys = flatten(ar as Catalogue);

interface Usage {
  file: string;
  line: number;
  /** Every namespace this call could plausibly resolve against. */
  candidates: string[];
  key: string;
}

/**
 * Extracts `t('key')` calls and resolves them against the namespace bound to
 * that translator variable.
 *
 * Handles the two forms this codebase uses:
 *   const t = useTranslations('ns');                    // Client Components
 *   const t = await getTranslations('ns');              // Server Components
 *   const t = await getTranslations({ locale, namespace: 'ns' });
 */
function extractUsages(file: string): { usages: Usage[]; dynamic: number } {
  const contents = readFileSync(file, 'utf8');
  const lines = contents.split('\n');

  // variable name -> every namespace that name is bound to in this file
  const translators = new Map<string, Set<string>>();
  const usages: Usage[] = [];
  let dynamic = 0;

  const bindingPatterns = [
    /(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?getTranslations\(\s*\{[^}]*namespace:\s*['"]([^'"]+)['"]/g,
    // A translator with no namespace resolves keys from the catalogue root.
    /(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\(\s*\)/g,
  ];

  for (const pattern of bindingPatterns) {
    for (const match of contents.matchAll(pattern)) {
      const variable = match[1];
      if (!variable) continue;
      const namespaces = translators.get(variable) ?? new Set<string>();
      namespaces.add(match[2] ?? '');
      translators.set(variable, namespaces);
    }
  }

  if (translators.size === 0) return { usages: [], dynamic: 0 };

  const names = [...translators.keys()].join('|');
  const callPattern = new RegExp(`\\b(${names})\\(\\s*(['"\`])([^'"\`]*)\\2`, 'g');
  const dynamicPattern = new RegExp(`\\b(${names})\\(\\s*\``, 'g');

  lines.forEach((line, index) => {
    // Template literals are dynamic keys: count them, do not guess.
    for (const _ of line.matchAll(dynamicPattern)) {
      void _;
      dynamic += 1;
    }

    for (const match of line.matchAll(callPattern)) {
      const variable = match[1];
      const key = match[3];
      // Backtick calls were already counted as dynamic.
      if (!variable || key === undefined || match[2] === '`') continue;

      const namespaces = translators.get(variable);
      if (namespaces === undefined) continue;

      usages.push({
        file: path.relative(SOURCE_ROOT, file),
        line: index + 1,
        candidates: [...namespaces].map((namespace) =>
          namespace ? `${namespace}.${key}` : key,
        ),
        key,
      });
    }
  });

  return { usages, dynamic };
}

describe('translation usage', () => {
  const files = globSync('**/*.{ts,tsx}', { cwd: SOURCE_ROOT }).map((relative) =>
    path.join(SOURCE_ROOT, relative),
  );

  const allUsages: Usage[] = [];
  let dynamicCount = 0;

  for (const file of files) {
    const { usages, dynamic } = extractUsages(file);
    allUsages.push(...usages);
    dynamicCount += dynamic;
  }

  it('finds translation calls to analyse', () => {
    // Guards against the extractor silently matching nothing, which would make
    // every assertion below pass vacuously.
    expect(allUsages.length).toBeGreaterThan(50);
  });

  function unresolved(catalogue: Set<string>): string[] {
    const missing = allUsages
      .filter((usage) => !usage.candidates.some((candidate) => catalogue.has(candidate)))
      .map(
        (usage) =>
          `${usage.file}:${usage.line} — "${usage.key}" not found as ${usage.candidates.join(' | ')}`,
      );
    return [...new Set(missing)];
  }

  it('resolves every literal key against the English catalogue', () => {
    expect(unresolved(enKeys), 'keys used in code but absent from en.json').toEqual([]);
  });

  it('resolves every literal key against the Arabic catalogue', () => {
    expect(unresolved(arKeys), 'keys used in code but absent from ar.json').toEqual([]);
  });

  it('reports how many keys are built dynamically', () => {
    // Dynamic keys (`agents.${key}.shortTitle`) cannot be verified statically.
    // Keeping the count visible means a growing number is a deliberate choice
    // rather than an accident that erodes this test's coverage.
    expect(dynamicCount).toBeLessThan(25);
  });
});
