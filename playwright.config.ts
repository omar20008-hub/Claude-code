import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';
import { loadEnvConfig } from '@next/env';

/**
 * Load `.env` the same way the server under test does.
 *
 * Playwright does not read `.env`, but the fixtures need `DATABASE_URL` (to
 * activate a registered account and to clear rate-limit windows) and `APP_URL`
 * (to send an acceptable `Origin`). Without this the fixtures silently address
 * a *different* database than the running server, and the failures that
 * produces — 403 on every POST, or a rate limit that "will not clear" — look
 * like product bugs rather than a configuration gap.
 *
 * `loadEnvConfig` is Next's own loader, so precedence here is identical to the
 * server's. Anything already exported in the environment still wins, which is
 * what lets CI point the suite at its own database.
 */
const HAD_NODE_ENV = process.env.NODE_ENV !== undefined;
loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });

// `.env` carries `NODE_ENV=development` for `next dev`. Letting that reach the
// web server would have the suite exercise the development configuration —
// a looser CSP and a cookie without the `__Host-` prefix — which is not what
// ships. The suite runs against the production build, so the value a developer
// keeps for `npm run dev` is dropped here unless it was set deliberately.
// `process.env.NODE_ENV` is typed read-only by @types/node; deleting the key is
// the intent, so the index access goes through the untyped record.
if (!HAD_NODE_ENV) delete (process.env as Record<string, string | undefined>).NODE_ENV;

/**
 * Chromium executable.
 *
 * Some environments ship a pre-installed browser whose build number does not
 * match the one this Playwright version would download (a CI image with a
 * pinned browser, a sandbox with no network). Pointing at it explicitly is
 * cheaper and more reliable than re-downloading ~150 MB on every run.
 *
 * `undefined` falls back to Playwright's own managed browser, which is the
 * normal case on a developer machine.
 */
const PRESET_CHROMIUM = [
  process.env.PLAYWRIGHT_CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
].find((candidate) => candidate && existsSync(candidate));

const chromiumLaunch = PRESET_CHROMIUM
  ? { launchOptions: { executablePath: PRESET_CHROMIUM } }
  : {};

/**
 * The origin under test.
 *
 * This must be the *same string* the server has as `APP_URL`, not merely an
 * address that reaches it. State-changing requests carry an `Origin` header
 * that the handler compares against `APP_URL`, so driving `127.0.0.1:3000`
 * against a server configured for `localhost:3000` makes every POST a 403 —
 * the CSRF control working exactly as designed, on a false positive. The
 * default therefore matches `.env.example`; CI sets both from one value.
 */
const APP_URL = process.env.APP_URL ?? 'http://localhost:3000';

/**
 * End-to-end configuration.
 *
 * Two projects, one per language, rather than one project that switches
 * language mid-run. Each gets its own browser locale so the negotiation path is
 * exercised for real, and a failure is attributable to a language rather than
 * to a switch.
 */
export default defineConfig({
  testDir: './tests/e2e',
  // A direction bug that only appears under load is not a thing; parallelism
  // here is purely about wall-clock time.
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  timeout: 45_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: APP_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'arabic-rtl',
      use: {
        ...devices['Desktop Chrome'],
        ...chromiumLaunch,
        locale: 'ar-SA',
        // Drives the Accept-Language negotiation the middleware performs.
        extraHTTPHeaders: { 'Accept-Language': 'ar-SA,ar;q=0.9' },
      },
    },
    {
      name: 'english-ltr',
      use: {
        ...devices['Desktop Chrome'],
        ...chromiumLaunch,
        locale: 'en-US',
        extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
      },
    },
    {
      // Complex workflows are desktop-first (§41), but the shell must stay
      // usable on a phone — and the mobile drawer is a direction-sensitive
      // component, so it is worth exercising in RTL specifically.
      name: 'mobile-rtl',
      use: {
        ...devices['Pixel 7'],
        ...chromiumLaunch,
        locale: 'ar-SA',
        extraHTTPHeaders: { 'Accept-Language': 'ar-SA,ar;q=0.9' },
      },
    },
  ],

  webServer: {
    command: 'npm run start',
    url: `${APP_URL}/api/v1/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
