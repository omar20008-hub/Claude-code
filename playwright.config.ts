import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

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
    baseURL: process.env.APP_URL ?? 'http://127.0.0.1:3000',
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
    url: 'http://127.0.0.1:3000/api/v1/health',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
