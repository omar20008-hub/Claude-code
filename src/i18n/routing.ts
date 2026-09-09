import { defineRouting } from 'next-intl/routing';
import { createNavigation } from 'next-intl/navigation';
import { locales, defaultLocale } from './config';

/**
 * Locale routing.
 *
 * Every page lives under `/[locale]/…`, including the default locale
 * (`localePrefix: 'always'`). That is a deliberate choice over hiding the
 * default prefix:
 *
 *  - The direction of the document is derivable from the URL alone, so the
 *    server can emit `<html dir>` correctly on the very first byte. No
 *    flash of mis-directed layout.
 *  - Every page is linkable in a specific language, which matters when an
 *    Arabic-speaking manager forwards a campaign review to an English-speaking
 *    colleague.
 *  - Caches key on the URL, so no Vary: Cookie is needed to serve two
 *    languages.
 */
export const routing = defineRouting({
  locales,
  defaultLocale,
  localePrefix: 'always',
  // The cookie records an explicit choice from the switcher. Absent it, the
  // middleware negotiates from Accept-Language.
  localeCookie: {
    name: 'AIW_LOCALE',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
  },
  localeDetection: true,
});

/**
 * Locale-aware navigation primitives. Using these instead of `next/link` and
 * `next/navigation` is what keeps the locale prefix on every internal link
 * without a single component having to think about it.
 */
export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);
