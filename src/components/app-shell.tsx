'use client';

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/routing';
import { LanguageSwitcher } from './language-switcher';
import { ThemeToggle } from './theme-toggle';
import { cn, Button } from './ui/primitives';
import {
  IconDashboard,
  IconAgents,
  IconKnowledge,
  IconCreative,
  IconAdvertising,
  IconAssets,
  IconCampaigns,
  IconAnalytics,
  IconActivity,
  IconSettings,
  IconMenu,
  IconClose,
} from './ui/icons';

/**
 * Authenticated application shell (§12).
 *
 * The sidebar sits at the reading start — the inline-start edge — so it appears
 * on the left in English and on the right in Arabic. That falls out of flex
 * ordering plus a logical `border-e`; there is no `dir === 'rtl'` branch
 * anywhere in this file, and no mirrored stylesheet.
 */

interface NavItem {
  href: string;
  labelKey: string;
  icon: ReactNode;
}

interface NavSection {
  titleKey: string;
  items: NavItem[];
}

const NAV_SECTIONS: NavSection[] = [
  {
    titleKey: 'sections.overview',
    items: [{ href: '/dashboard', labelKey: 'dashboard', icon: <IconDashboard /> }],
  },
  {
    titleKey: 'sections.workforce',
    items: [
      { href: '/agents', labelKey: 'agents', icon: <IconAgents /> },
      { href: '/knowledge', labelKey: 'knowledge', icon: <IconKnowledge /> },
      { href: '/creative', labelKey: 'creative', icon: <IconCreative /> },
      { href: '/advertising', labelKey: 'advertising', icon: <IconAdvertising /> },
    ],
  },
  {
    titleKey: 'sections.library',
    items: [
      { href: '/assets', labelKey: 'assets', icon: <IconAssets /> },
      { href: '/campaigns', labelKey: 'campaigns', icon: <IconCampaigns /> },
    ],
  },
  {
    titleKey: 'sections.insights',
    items: [
      { href: '/analytics', labelKey: 'analytics', icon: <IconAnalytics /> },
      { href: '/activity', labelKey: 'activity', icon: <IconActivity /> },
    ],
  },
  {
    titleKey: 'sections.administration',
    items: [{ href: '/settings', labelKey: 'settings', icon: <IconSettings /> }],
  },
];

export function AppShell({
  children,
  user,
}: {
  children: ReactNode;
  user: { name: string; email: string; organizationName: string };
}) {
  const t = useTranslations('nav');
  const tCommon = useTranslations('common.actions');
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  function isActive(href: string): boolean {
    // Exact match, or a descendant route — /campaigns/:id keeps /campaigns lit.
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  const navigation = (
    <nav aria-label={t('primary')} className="flex flex-col gap-6 py-4">
      {NAV_SECTIONS.map((section) => (
        <div key={section.titleKey}>
          <h2 className="px-3 pb-2 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            {t(section.titleKey)}
          </h2>
          <ul className="flex flex-col gap-0.5">
            {section.items.map((item) => {
              const active = isActive(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setMobileOpen(false)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-3 rounded-[var(--radius-control)] px-3 py-2 text-sm transition-colors',
                      active
                        ? 'bg-[var(--color-brand-50)] font-medium text-[var(--color-brand-700)]'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--surface-raised)] hover:text-[var(--text-primary)]',
                    )}
                  >
                    <span className="shrink-0 [&>svg]:size-4.5" aria-hidden="true">
                      {item.icon}
                    </span>
                    <span className="truncate">{t(item.labelKey)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );

  return (
    <div className="flex min-h-dvh">
      {/* --- Sidebar (desktop) ------------------------------------------- */}
      {/* `border-e` is a logical end-border: it renders on the sidebar's
          trailing edge, which is its right in English and its left in Arabic. */}
      <aside
        className={cn(
          'hidden w-64 shrink-0 border-e border-[var(--border-subtle)] bg-[var(--surface-card)] lg:block',
        )}
      >
        <div className="sticky top-0 flex h-dvh flex-col overflow-y-auto scrollbar-slim px-3">
          <BrandMark organizationName={user.organizationName} />
          {navigation}
          <div className="mt-auto border-t border-[var(--border-subtle)] py-3">
            <UserCard user={user} />
          </div>
        </div>
      </aside>

      {/* --- Sidebar (mobile drawer) ------------------------------------- */}
      {mobileOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
          {/* `start-0` pins the drawer to the reading edge in both directions. */}
          <div className="absolute inset-y-0 start-0 flex w-72 flex-col overflow-y-auto scrollbar-slim border-e border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 shadow-[var(--shadow-overlay)]">
            <div className="flex items-center justify-between py-3">
              <BrandMark organizationName={user.organizationName} compact />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setMobileOpen(false)}
                aria-label={tCommon('closeMenu')}
              >
                <IconClose />
              </Button>
            </div>
            {navigation}
            <div className="mt-auto border-t border-[var(--border-subtle)] py-3">
              <UserCard user={user} />
            </div>
          </div>
        </div>
      ) : null}

      {/* --- Main column -------------------------------------------------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-[var(--border-subtle)] bg-[var(--surface-card)]/95 px-4 backdrop-blur">
          <Button
            variant="ghost"
            size="sm"
            className="lg:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label={tCommon('openMenu')}
            aria-expanded={mobileOpen}
          >
            <IconMenu />
          </Button>

          {/* `ms-auto` pushes the controls to the reading end. */}
          <div className="ms-auto flex items-center gap-2">
            <LanguageSwitcher />
            <ThemeToggle />
          </div>
        </header>

        <main id="main-content" className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}

function BrandMark({
  organizationName,
  compact,
}: {
  organizationName: string;
  compact?: boolean;
}) {
  const t = useTranslations('app');

  return (
    <div className={cn('flex items-center gap-2.5', compact ? 'py-0' : 'py-4')}>
      <div className="grid size-9 shrink-0 place-items-center rounded-[var(--radius-control)] bg-[var(--color-brand-600)] text-white">
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
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-[var(--text-primary)]">
          {organizationName}
        </p>
        <p className="truncate text-xs text-[var(--text-muted)]">{t('name')}</p>
      </div>
    </div>
  );
}

function UserCard({ user }: { user: { name: string; email: string } }) {
  const t = useTranslations('common.actions');

  async function signOut() {
    await fetch('/api/v1/auth/logout', { method: 'POST' });
    // A full reload rather than a client navigation: it clears every cached
    // server component payload, so no tenant data survives the sign-out.
    window.location.assign('/');
  }

  return (
    <div className="flex items-center gap-2.5 px-3">
      <div className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--surface-sunken)] text-xs font-semibold text-[var(--text-secondary)]">
        {user.name.slice(0, 2).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-[var(--text-primary)]">{user.name}</p>
        {/* An email address is Latin text that must not reorder inside Arabic UI. */}
        <p className="force-ltr truncate text-xs text-[var(--text-muted)]">{user.email}</p>
      </div>
      <Button variant="ghost" size="sm" onClick={signOut} aria-label={t('signOut')}>
        <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden="true" data-flip-rtl>
          <path
            d="M15 17l5-5-5-5M20 12H9M12 19H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </Button>
    </div>
  );
}
