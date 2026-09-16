/**
 * Applies the stored theme before first paint.
 *
 * This has to be an inline, blocking script in <head>. Doing it in a React
 * effect would paint the default theme first and then swap, which is the
 * "flash of wrong theme" every dark-mode implementation trips over.
 *
 * It reads localStorage, falls back to the OS preference, and is wrapped in
 * try/catch because localStorage throws outright in some privacy modes — a
 * theme preference must never be able to break the page.
 */
const SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem('aiw-theme');
    var theme = stored === 'light' || stored === 'dark'
      ? stored
      : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    /* Storage unavailable: the CSS media query already provides a sane default. */
  }
})();
`.trim();

export function ThemeScript() {
  return (
    <script
      // The content is a constant defined in this file; no user input reaches it.
      dangerouslySetInnerHTML={{ __html: SCRIPT }}
    />
  );
}

export const THEME_STORAGE_KEY = 'aiw-theme';
