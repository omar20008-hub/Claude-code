import { expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

/**
 * End-to-end helpers.
 *
 * Accounts are created through the real registration endpoint and then
 * activated by flipping the status directly, rather than by scraping a
 * verification token out of a log. That keeps the fixture from depending on log
 * formatting, while still exercising the registration path itself.
 */

const ADMIN_URL =
  process.env.TEST_ADMIN_DATABASE_URL ??
  process.env.DATABASE_URL?.replace(/\/\/[^@]+@/, '//postgres@') ??
  'postgres://postgres@127.0.0.1:5432/ai_workforce_e2e';

let admin: postgres.Sql | undefined;

function sql(): postgres.Sql {
  admin ??= postgres(ADMIN_URL, { max: 2, onnotice: () => {} });
  return admin;
}

export async function closeAdmin(): Promise<void> {
  if (admin) {
    await admin.end({ timeout: 5 });
    admin = undefined;
  }
}

/**
 * The app's own origin.
 *
 * State-changing API calls must carry a matching `Origin`; the handler rejects
 * anything else with 403 (the CSRF control). A request issued before the page
 * has navigated has `about:blank` as its URL, whose origin is the string
 * "null" — which the server correctly refuses.
 */
const APP_ORIGIN = new URL(process.env.APP_URL ?? 'http://localhost:3000').origin;

export interface TestAccount {
  email: string;
  password: string;
  organizationName: string;
  name: string;
}

/** Registers a tenant through the API and activates it. */
export async function createAccount(
  page: Page,
  locale: 'ar' | 'en',
): Promise<TestAccount> {
  const suffix = randomUUID().slice(0, 8);
  const account: TestAccount = {
    email: `e2e-${suffix}@example.test`,
    password: 'vault-tumbler-orchid-quay',
    organizationName: locale === 'ar' ? `مؤسسة ${suffix}` : `Org ${suffix}`,
    name: locale === 'ar' ? 'ليلى المدير' : 'Layla Admin',
  };

  const response = await page.request.post('/api/v1/auth/register', {
    headers: { Origin: APP_ORIGIN },
    data: { ...account, locale },
  });
  expect(response.status(), await response.text()).toBe(201);

  // Registration deliberately leaves the account PENDING_VERIFICATION. Activate
  // it here so each test starts from a signed-in state without re-testing the
  // verification flow, which has its own coverage.
  await sql()`
    UPDATE users
       SET status = 'ACTIVE', email_verified_at = now()
     WHERE lower(email) = ${account.email.toLowerCase()}
  `;

  return account;
}

/** Signs in and lands on the dashboard. */
export async function signIn(
  page: Page,
  account: TestAccount,
  locale: 'ar' | 'en',
): Promise<void> {
  await page.goto(`/${locale}/login`);

  // Rate limits are per-IP and every test shares one; clear the counters so a
  // long run does not start failing on the sixth sign-in.
  await sql()`DELETE FROM rate_limits`;

  // Filled by id rather than by label text. The labels are translated, so a
  // label-based selector would need a lookup table per language and would break
  // on any copy change — neither of which is what these tests are about. The
  // localized text IS asserted, in the direction and content checks.
  await page.locator('#email').fill(account.email);
  await page.locator('#password').fill(account.password);
  await page.getByRole('button', { name: locale === 'ar' ? 'تسجيل الدخول' : 'Sign in' }).click();

  await page.waitForURL(new RegExp(`/${locale}/dashboard`), { timeout: 20_000 });
}

/**
 * Asserts the page really is laid out in the expected direction.
 *
 * Checks the document attributes AND a computed style, because `dir="rtl"` on
 * <html> with a stylesheet full of physical properties still lays out
 * left-to-right — the attribute alone proves nothing.
 */
export async function expectDirection(
  page: Page,
  expected: 'rtl' | 'ltr',
  locale: 'ar' | 'en',
): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('dir', expected);
  await expect(page.locator('html')).toHaveAttribute('lang', locale);

  const computed = await page.evaluate(() => getComputedStyle(document.body).direction);
  expect(computed).toBe(expected);
}

/** Fails if the page scrolls sideways — the classic RTL layout break (§41). */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      // Report the widest offender so a failure is actionable.
      widest: Array.from(document.querySelectorAll('*'))
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return { tag: element.tagName, cls: element.className, right: rect.right, left: rect.left };
        })
        .filter((entry) => entry.right > doc.clientWidth + 2 || entry.left < -2)
        .slice(0, 3),
    };
  });

  expect(
    overflow.scrollWidth,
    `page scrolls horizontally; widest offenders: ${JSON.stringify(overflow.widest)}`,
  ).toBeLessThanOrEqual(overflow.clientWidth + 2);
}

/** Clears rate-limit counters between tests sharing one source IP. */
export async function clearRateLimits(): Promise<void> {
  await sql()`DELETE FROM rate_limits`;
}
