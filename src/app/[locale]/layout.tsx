import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { NextIntlClientProvider, hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { routing } from '@/i18n/routing';
import { localeConfig, type Locale } from '@/i18n/config';
import { ThemeScript } from '@/components/theme-script';
import '../globals.css';

/**
 * Locale layout.
 *
 * This is where `lang` and `dir` are set, on the server, from the URL segment.
 * Two consequences matter:
 *
 *  - The correct direction is in the very first byte of HTML. There is no
 *    client-side `useEffect` flipping `dir` after hydration, so an Arabic user
 *    never sees a frame of left-to-right layout.
 *  - Every CSS logical property in the design system resolves correctly during
 *    server rendering, so the markup that arrives is already laid out right.
 */

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};

  const t = await getTranslations({ locale, namespace: 'app' });

  return {
    title: { default: t('name'), template: `%s · ${t('name')}` },
    description: t('tagline'),
    robots: {
      // A tenant workspace has nothing to gain from being indexed, and a
      // crawled URL is one more way a link leaks.
      index: false,
      follow: false,
    },
    alternates: {
      languages: Object.fromEntries(
        routing.locales.map((l) => [localeConfig[l].tag, `/${l}`]),
      ),
    },
  };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  // Opts this subtree into static rendering where possible.
  setRequestLocale(locale);

  const config = localeConfig[locale as Locale];
  const t = await getTranslations({ locale, namespace: 'app' });

  return (
    <html
      lang={locale}
      dir={config.direction}
      // The theme script writes data-theme before hydration; without this the
      // server/client attribute mismatch logs a warning on every load.
      suppressHydrationWarning
    >
      <head>
        <ThemeScript />
      </head>
      <body>
        {/* First focusable element on the page (§40). */}
        <a href="#main-content" className="skip-link">
          {t('skipToContent')}
        </a>
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
