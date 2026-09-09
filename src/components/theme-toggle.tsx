'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { THEME_STORAGE_KEY } from './theme-script';
import { Button } from './ui/primitives';
import { IconSun, IconMoon } from './ui/icons';

type Theme = 'light' | 'dark';

/**
 * Light/dark toggle.
 *
 * The current theme is read from the DOM attribute the blocking script in
 * <head> already set, rather than from storage directly — that keeps this
 * component and the pre-paint script from ever disagreeing.
 */
export function ThemeToggle() {
  const t = useTranslations('common.theme');
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const current = document.documentElement.getAttribute('data-theme');
    setTheme(current === 'dark' ? 'dark' : 'light');
  }, []);

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Private mode: the toggle still applies for this page view.
    }
  }

  return (
    <Button variant="ghost" size="sm" onClick={toggle} aria-label={t('toggle')}>
      {/* Renders nothing until mounted so the server and client markup match;
          the icon depends on state the server cannot know. */}
      {theme === null ? (
        <span className="size-4" />
      ) : theme === 'dark' ? (
        <IconSun className="size-4" />
      ) : (
        <IconMoon className="size-4" />
      )}
    </Button>
  );
}
