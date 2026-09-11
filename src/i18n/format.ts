import { localeConfig, type Locale } from './config';

/**
 * Direction-aware and locale-aware formatting helpers.
 *
 * These exist so no component formats a number or a date by hand. Two problems
 * they solve that `toLocaleString` alone does not:
 *
 *  1. Bidi isolation. A Latin filename or a URL rendered inside an Arabic
 *     sentence reorders under the Unicode bidirectional algorithm — "HR
 *     Policy.pdf" can render as ".HR Policy.pdf" or split around punctuation.
 *     `isolate()` wraps such values in U+2068/U+2069 so they stay intact.
 *  2. Consistent currency handling from minor units, which is how every money
 *     value is stored.
 */

export function formatNumber(
  value: number,
  locale: Locale,
  options: Intl.NumberFormatOptions = {},
): string {
  const config = localeConfig[locale];
  return new Intl.NumberFormat(config.formatLocale, {
    numberingSystem: config.numberingSystem,
    ...options,
  }).format(value);
}

/** Formats a minor-unit amount (halalas, cents) as currency. */
export function formatCurrencyMinor(
  minorUnits: number,
  currency: string,
  locale: Locale,
): string {
  return formatNumber(minorUnits / 100, locale, {
    style: 'currency',
    currency,
    // Whole-riyal budgets read better without ".00" on a dashboard tile.
    minimumFractionDigits: minorUnits % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

export function formatPercent(ratio: number, locale: Locale, digits = 2): string {
  return formatNumber(ratio, locale, {
    style: 'percent',
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
}

export function formatDate(
  value: Date | string | number,
  locale: Locale,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
  timeZone = 'Asia/Riyadh',
): string {
  const config = localeConfig[locale];
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat(config.formatLocale, {
    numberingSystem: config.numberingSystem,
    timeZone,
    ...options,
  }).format(date);
}

/**
 * "3 minutes ago" / "قبل ٣ دقائق", using Intl.RelativeTimeFormat so the plural
 * rules are the language's own rather than an English-shaped `n === 1` check.
 * Arabic has six plural categories; hand-rolled pluralization gets it wrong.
 */
export function formatRelativeTime(value: Date | string | number, locale: Locale): string {
  const config = localeConfig[locale];
  const date = value instanceof Date ? value : new Date(value);
  const deltaSeconds = Math.round((date.getTime() - Date.now()) / 1000);

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 60 * 60 * 24 * 365],
    ['month', 60 * 60 * 24 * 30],
    ['week', 60 * 60 * 24 * 7],
    ['day', 60 * 60 * 24],
    ['hour', 60 * 60],
    ['minute', 60],
    ['second', 1],
  ];

  const formatter = new Intl.RelativeTimeFormat(config.formatLocale, {
    numeric: 'auto',
    style: 'long',
  });

  for (const [unit, seconds] of units) {
    if (Math.abs(deltaSeconds) >= seconds || unit === 'second') {
      return formatter.format(Math.round(deltaSeconds / seconds), unit);
    }
  }
  return formatter.format(0, 'second');
}

/** Formats a byte count with binary units. */
export function formatBytes(bytes: number, locale: Locale): string {
  if (bytes === 0) return formatNumber(0, locale) + ' B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(
    Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** exponent;
  return `${formatNumber(value, locale, { maximumFractionDigits: exponent === 0 ? 0 : 1 })} ${units[exponent]}`;
}

/** Formats a duration in milliseconds as a short human string. */
export function formatDuration(ms: number, locale: Locale): string {
  if (ms < 1000) return `${formatNumber(Math.round(ms), locale)} ms`;
  if (ms < 60_000) return `${formatNumber(ms / 1000, locale, { maximumFractionDigits: 1 })} s`;
  return `${formatNumber(ms / 60_000, locale, { maximumFractionDigits: 1 })} min`;
}

const FIRST_STRONG_ISOLATE = '⁨';
const POP_DIRECTIONAL_ISOLATE = '⁩';

/**
 * Wraps text whose direction differs from the surrounding paragraph in a
 * Unicode isolate.
 *
 * Use for any value the application did not author: document filenames, URLs,
 * Meta campaign IDs, user-entered names. Without it, a filename ending in
 * ".pdf" inside an Arabic sentence renders with the extension on the wrong
 * side, which reads as a corrupted filename to an Arabic speaker.
 */
export function isolate(text: string): string {
  return `${FIRST_STRONG_ISOLATE}${text}${POP_DIRECTIONAL_ISOLATE}`;
}

/**
 * True when a string's first strong character is RTL. Used to set `dir="auto"`
 * decisions explicitly where `auto` is not granular enough — for example a
 * chat bubble whose content language may differ from the UI language.
 */
export function detectDirection(text: string): 'rtl' | 'ltr' {
  // Arabic, Hebrew, Syriac, Thaana, plus Arabic Supplement/Extended and
  // Presentation Forms.
  const rtl = /[֐-׿؀-ۿ܀-ݏݐ-ݿހ-޿ࢠ-ࣿיִ-﷿ﹰ-﻿]/;
  const ltr = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/;

  for (const char of text) {
    if (rtl.test(char)) return 'rtl';
    if (ltr.test(char)) return 'ltr';
  }
  return 'ltr';
}
