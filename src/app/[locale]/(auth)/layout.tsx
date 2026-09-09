import { getTranslations } from 'next-intl/server';
import { LanguageSwitcher } from '@/components/language-switcher';
import { ThemeToggle } from '@/components/theme-toggle';

/**
 * Public authentication layout.
 *
 * The language switcher is present here too, and deliberately so: someone who
 * cannot read the sign-in form cannot reach the setting that would fix it. It
 * runs with `persist={false}` because there is no account yet — the cookie and
 * the URL carry the choice until there is.
 */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations('app');

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center gap-3 px-4 py-4 sm:px-6">
        <div className="flex items-center gap-2.5">
          <div className="grid size-9 place-items-center rounded-[var(--radius-control)] bg-[var(--color-brand-600)] text-white">
            <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden="true">
              <path
                d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
              <circle cx="12" cy="12" r="2.6" fill="currentColor" />
            </svg>
          </div>
          <span className="text-sm font-semibold text-[var(--text-primary)]">{t('name')}</span>
        </div>

        {/* `ms-auto` pushes these to the reading end in both directions. */}
        <div className="ms-auto flex items-center gap-2">
          <LanguageSwitcher persist={false} />
          <ThemeToggle />
        </div>
      </header>

      <main
        id="main-content"
        className="flex flex-1 items-center justify-center px-4 py-8 sm:px-6"
      >
        <div className="w-full max-w-md">{children}</div>
      </main>

      <footer className="px-4 py-6 text-center text-xs text-[var(--text-muted)]">
        {t('tagline')}
      </footer>
    </div>
  );
}
