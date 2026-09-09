import { getRequestConfig } from 'next-intl/server';
import { hasLocale } from 'next-intl';
import { routing } from './routing';
import { localeConfig, type Locale } from './config';

/**
 * Per-request i18n configuration.
 *
 * Message catalogues are imported dynamically so a request only ever ships one
 * language's strings; the other never enters the server response or the client
 * bundle.
 */
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale: Locale = hasLocale(routing.locales, requested)
    ? requested
    : routing.defaultLocale;

  const config = localeConfig[locale];

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
    timeZone: 'Asia/Riyadh',
    formats: {
      dateTime: {
        short: { day: 'numeric', month: 'short', year: 'numeric' },
        long: {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
          hour: 'numeric',
          minute: 'numeric',
        },
        time: { hour: 'numeric', minute: 'numeric' },
      },
      number: {
        // Ad spend and budgets. Currency is injected per organization.
        currency: {
          style: 'currency',
          currency: 'SAR',
          numberingSystem: config.numberingSystem,
        },
        integer: { maximumFractionDigits: 0, numberingSystem: config.numberingSystem },
        percent: {
          style: 'percent',
          maximumFractionDigits: 2,
          numberingSystem: config.numberingSystem,
        },
        compact: {
          notation: 'compact',
          maximumFractionDigits: 1,
          numberingSystem: config.numberingSystem,
        },
      },
    },
    /**
     * A missing key is a bug, not a runtime fallback to English. In development
     * it throws loudly so the i18n test suite catches it; in production it
     * degrades to the key path rather than taking the page down.
     */
    onError(error) {
      if (process.env.NODE_ENV === 'development') {
        throw error;
      }
      // eslint-disable-next-line no-console
      console.error('[i18n]', error.message);
    },
    getMessageFallback({ namespace, key }) {
      return [namespace, key].filter(Boolean).join('.');
    },
  };
});
