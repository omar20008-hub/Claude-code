'use client';

import { useTransition } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname, useRouter } from '@/i18n/routing';
import { useParams } from 'next/navigation';
import { locales, localeConfig, type Locale } from '@/i18n/config';
import { cn } from '@/components/ui/primitives';

/**
 * Global language switcher (§5).
 *
 * Renders as `العربية | English` — each language in its own script, never
 * translated, because a reader looking for their language scans for its
 * endonym.
 *
 * Switching does three things:
 *  1. Navigates to the same route under the other locale prefix, so the user
 *     stays exactly where they were.
 *  2. Lets next-intl write the AIW_LOCALE cookie, which the middleware reads on
 *     the next un-prefixed request.
 *  3. Persists the choice against the signed-in account, so it follows the user
 *     to another device. Fire-and-forget: a failed persist must not block the
 *     switch the user just asked for.
 */
export function LanguageSwitcher({
  className,
  persist = true,
}: {
  className?: string;
  /** Off on the public auth pages, where there is no account to save against. */
  persist?: boolean;
}) {
  const t = useTranslations('language');
  const currentLocale = useLocale() as Locale;
  const pathname = usePathname();
  const router = useRouter();
  const params = useParams();
  const [isPending, startTransition] = useTransition();

  function switchTo(next: Locale) {
    if (next === currentLocale) return;

    if (persist) {
      // Not awaited: the navigation below should not wait on a round trip, and
      // the cookie already carries the preference for this browser.
      void fetch('/api/v1/me/locale', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale: next }),
      }).catch(() => {
        /* The cookie and URL still reflect the choice. */
      });
    }

    startTransition(() => {
      // `params` is forwarded so a dynamic route ([id]) keeps its segment
      // values across the locale change.
      router.replace(
        // @ts-expect-error -- pathname is a runtime value, not a literal route
        { pathname, params },
        { locale: next },
      );
    });
  }

  return (
    <div
      className={cn('flex items-center gap-1', className)}
      role="group"
      aria-label={t('switcher')}
    >
      {locales.map((locale, index) => {
        const isActive = locale === currentLocale;
        const config = localeConfig[locale];

        return (
          <span key={locale} className="flex items-center">
            {index > 0 ? (
              <span aria-hidden="true" className="mx-1 text-[var(--text-muted)]">
                |
              </span>
            ) : null}
            <button
              type="button"
              // `lang` and `dir` per button so each endonym renders in its own
              // script regardless of the surrounding page direction.
              lang={locale}
              dir={config.direction}
              onClick={() => switchTo(locale)}
              disabled={isPending}
              aria-current={isActive ? 'true' : undefined}
              aria-label={
                isActive ? t('current', { language: config.label }) : t('switchTo', { language: config.label })
              }
              className={cn(
                'rounded-[var(--radius-control)] px-2 py-1 text-sm transition-colors',
                'disabled:opacity-60',
                isActive
                  ? 'font-semibold text-[var(--text-brand)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
              )}
            >
              {config.label}
            </button>
          </span>
        );
      })}
    </div>
  );
}
