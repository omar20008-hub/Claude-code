import type { ReactNode } from 'react';
import './globals.css';

/**
 * Root layout.
 *
 * Deliberately minimal: `lang` and `dir` cannot be set correctly here because
 * the locale is not known until the `[locale]` segment resolves. Next requires
 * a root layout with html/body, so this one renders them as a shell and
 * src/app/[locale]/layout.tsx supplies the real attributes.
 *
 * `suppressHydrationWarning` is on <html> because the theme script below sets
 * `data-theme` before React hydrates, which is what prevents a flash of the
 * wrong theme.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return children;
}
