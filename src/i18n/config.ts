/**
 * Localization configuration.
 *
 * This module is the single source of truth for which languages exist, which
 * direction each one lays out in, and how each formats dates and numbers. It is
 * imported by the middleware, the server, and Client Components alike, so it
 * must stay free of Node-only imports.
 */

export const locales = ['ar', 'en'] as const;
export type Locale = (typeof locales)[number];

export type Direction = 'rtl' | 'ltr';

/**
 * Fallback when the browser expresses no usable preference.
 *
 * Arabic-first is deliberate: the product is aimed at Saudi/Gulf organizations,
 * and §5 requires an Arabic browser to land on Arabic. Overridable per
 * deployment via DEFAULT_LOCALE and per tenant via organizations.defaultLocale.
 */
export const defaultLocale: Locale = 'ar';

export const localeConfig: Record<
  Locale,
  {
    /** BCP-47 tag sent to the agents as `locale` metadata. */
    tag: string;
    direction: Direction;
    /** Endonym, as shown in the language switcher. Never translated. */
    label: string;
    /** Intl locale used for dates and numbers. */
    formatLocale: string;
    /**
     * Arabic-Indic vs Western digits.
     *
     * Saudi business software overwhelmingly uses Western (Latin) digits even
     * in Arabic UI — an invoice reading ٣٥٠٫٠٠ ر.س. looks archaic next to
     * 350.00 ر.س. So Arabic uses `latn` numerals with Arabic month names and
     * the Gregorian calendar, which is what an accountant in Riyadh expects.
     */
    numberingSystem: 'latn' | 'arab';
    /** Font stack; Arabic needs a face with proper Naskh shaping. */
    fontFamily: string;
  }
> = {
  ar: {
    tag: 'ar-SA',
    direction: 'rtl',
    label: 'العربية',
    formatLocale: 'ar-SA-u-nu-latn-ca-gregory',
    numberingSystem: 'latn',
    fontFamily: 'var(--font-arabic)',
  },
  en: {
    tag: 'en-US',
    direction: 'ltr',
    label: 'English',
    formatLocale: 'en-US',
    numberingSystem: 'latn',
    fontFamily: 'var(--font-latin)',
  },
};

/**
 * Cookie that records an explicit language choice.
 *
 * Declared here rather than read back off next-intl's routing object, whose
 * `localeCookie` is typed as `boolean | CookieAttributes` — the middleware needs
 * a plain string it can look up without narrowing a union on every request.
 */
export const LOCALE_COOKIE = 'AIW_LOCALE';

export function isLocale(value: string | undefined | null): value is Locale {
  return value !== null && value !== undefined && (locales as readonly string[]).includes(value);
}

export function directionOf(locale: Locale): Direction {
  return localeConfig[locale].direction;
}

export function localeTag(locale: Locale): string {
  return localeConfig[locale].tag;
}

/**
 * Maps a BCP-47 tag from the agents or an Accept-Language header back to a
 * supported locale. Any Arabic variant (ar-EG, ar-AE, arb) resolves to `ar`.
 */
export function resolveLocale(tag: string | undefined | null): Locale | null {
  if (!tag) return null;
  const primary = tag.toLowerCase().split('-')[0];
  if (primary === 'ar' || primary === 'arb') return 'ar';
  if (primary === 'en') return 'en';
  return null;
}

/**
 * Negotiates a locale from an Accept-Language header, honouring q-values.
 *
 * §5: an Arabic browser gets Arabic, an English browser gets English, anything
 * else falls back to the configured default.
 */
export function negotiateLocale(
  acceptLanguage: string | null | undefined,
  fallback: Locale = defaultLocale,
): Locale {
  if (!acceptLanguage) return fallback;

  const ranked = acceptLanguage
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params
        .map((p) => p.trim())
        .find((p) => p.startsWith('q='))
        ?.slice(2);
      const quality = q === undefined ? 1 : Number.parseFloat(q);
      return {
        tag: (tag ?? '').trim(),
        quality: Number.isFinite(quality) ? quality : 0,
      };
    })
    // q=0 means "explicitly not acceptable".
    .filter((entry) => entry.tag.length > 0 && entry.quality > 0)
    .sort((a, b) => b.quality - a.quality);

  for (const entry of ranked) {
    if (entry.tag === '*') return fallback;
    const resolved = resolveLocale(entry.tag);
    if (resolved) return resolved;
  }

  return fallback;
}
