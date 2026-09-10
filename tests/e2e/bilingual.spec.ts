import { test, expect } from '@playwright/test';
import {
  createAccount,
  signIn,
  expectDirection,
  expectNoHorizontalOverflow,
  clearRateLimits,
  closeAdmin,
  type TestAccount,
} from './helpers';

/**
 * Bilingual and RTL/LTR end-to-end coverage (§44, §45).
 *
 * §44 says not to declare bilingual support complete until every major page has
 * been tested in both directions. This file is that test, run automatically
 * rather than by someone remembering to look.
 *
 * Each project supplies its own browser locale, so the language under test is
 * whichever project is running.
 */

const LOCALE = (projectName: string): 'ar' | 'en' =>
  projectName.startsWith('arabic') || projectName.startsWith('mobile') ? 'ar' : 'en';

const DIRECTION = (locale: 'ar' | 'en'): 'rtl' | 'ltr' => (locale === 'ar' ? 'rtl' : 'ltr');

/** Every page §44 lists, with the heading that proves it actually rendered. */
const PAGES: Array<{ path: string; heading: { ar: string; en: string } }> = [
  { path: 'dashboard', heading: { ar: 'لوحة التحكم', en: 'Dashboard' } },
  { path: 'agents', heading: { ar: 'الوكلاء الأذكياء', en: 'AI Agents' } },
  { path: 'knowledge', heading: { ar: 'المعرفة', en: 'Knowledge' } },
  { path: 'creative', heading: { ar: 'استوديو المحتوى', en: 'Creative Studio' } },
  { path: 'assets', heading: { ar: 'الأصول', en: 'Assets' } },
  { path: 'advertising', heading: { ar: 'إنشاء حملة', en: 'Create a campaign' } },
  { path: 'campaigns', heading: { ar: 'الحملات', en: 'Campaigns' } },
  { path: 'analytics', heading: { ar: 'التحليلات', en: 'Analytics' } },
  { path: 'activity', heading: { ar: 'سجل النشاط', en: 'Activity' } },
  { path: 'settings', heading: { ar: 'الإعدادات', en: 'Settings' } },
];

test.afterAll(async () => {
  await closeAdmin();
});

test.describe('locale negotiation', () => {
  test('sends the browser to its own language from the bare root', async ({ page }, testInfo) => {
    const locale = LOCALE(testInfo.project.name);

    await page.goto('/');

    // §5: an Arabic browser lands on Arabic, an English browser on English —
    // driven by Accept-Language alone, with no cookie and no prior visit.
    await expect(page).toHaveURL(new RegExp(`/${locale}(/|$)`));
    await expectDirection(page, DIRECTION(locale), locale);
  });

  test('keeps a shared link in the language it was shared in', async ({ page }, testInfo) => {
    const locale = LOCALE(testInfo.project.name);
    // The URL prefix always wins over the browser's preference, so forwarding a
    // link to a colleague shows them what the sender saw.
    const other = locale === 'ar' ? 'en' : 'ar';

    await page.goto(`/${other}/login`);
    await expect(page.locator('html')).toHaveAttribute('lang', other);
    await expectDirection(page, DIRECTION(other), other);
  });
});

test.describe('public pages', () => {
  for (const path of ['login', 'register', 'forgot-password']) {
    test(`/${path} renders in the right direction with no sideways scroll`, async ({
      page,
    }, testInfo) => {
      const locale = LOCALE(testInfo.project.name);

      await page.goto(`/${locale}/${path}`);
      await expectDirection(page, DIRECTION(locale), locale);
      await expectNoHorizontalOverflow(page);
      await expect(page.locator('main')).toBeVisible();
    });
  }

  test('the language switcher is reachable before signing in', async ({ page }, testInfo) => {
    const locale = LOCALE(testInfo.project.name);
    await page.goto(`/${locale}/login`);

    // Someone who cannot read the sign-in form must still be able to change
    // the language — the control cannot live behind authentication.
    await expect(page.getByRole('button', { name: /العربية|Arabic/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /English/ })).toBeVisible();
  });

  test('switching language moves to the other locale and flips direction', async ({
    page,
  }, testInfo) => {
    const locale = LOCALE(testInfo.project.name);
    const other = locale === 'ar' ? 'en' : 'ar';

    await page.goto(`/${locale}/login`);
    await expectDirection(page, DIRECTION(locale), locale);

    await page.getByRole('button', { name: other === 'ar' ? 'العربية' : 'English' }).click();

    await expect(page).toHaveURL(new RegExp(`/${other}/login`));
    await expectDirection(page, DIRECTION(other), other);
  });
});

test.describe('authenticated pages', () => {
  let account: TestAccount;

  test.beforeEach(async ({ page }, testInfo) => {
    const locale = LOCALE(testInfo.project.name);
    await clearRateLimits();
    account = await createAccount(page, locale);
    await signIn(page, account, locale);
  });

  for (const entry of PAGES) {
    test(`/${entry.path} renders correctly`, async ({ page }, testInfo) => {
      const locale = LOCALE(testInfo.project.name);

      await page.goto(`/${locale}/${entry.path}`);

      await expectDirection(page, DIRECTION(locale), locale);
      // The heading proves the page rendered its own content rather than an
      // error boundary that happens to carry the right dir attribute.
      await expect(
        page.getByRole('heading', { name: entry.heading[locale], level: 1 }).first(),
      ).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });
  }

  test('the sidebar sits at the reading edge', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.startsWith('mobile'), 'the sidebar is a drawer on mobile');

    const locale = LOCALE(testInfo.project.name);
    await page.goto(`/${locale}/dashboard`);

    const nav = page.getByRole('navigation', { name: locale === 'ar' ? 'التنقل الرئيسي' : 'Primary navigation' });
    await expect(nav).toBeVisible();

    const box = await nav.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(viewport).not.toBeNull();

    // The decisive geometric check. `dir="rtl"` proves nothing on its own: a
    // stylesheet full of physical properties would leave the sidebar on the
    // left for an Arabic reader.
    if (locale === 'ar') {
      expect(box!.x + box!.width).toBeGreaterThan(viewport!.width * 0.6);
    } else {
      expect(box!.x).toBeLessThan(viewport!.width * 0.4);
    }
  });

  test('language preference survives navigation and reload', async ({ page }, testInfo) => {
    const locale = LOCALE(testInfo.project.name);
    const other = locale === 'ar' ? 'en' : 'ar';

    await page.goto(`/${locale}/dashboard`);
    await page.getByRole('button', { name: other === 'ar' ? 'العربية' : 'English' }).click();
    await expect(page).toHaveURL(new RegExp(`/${other}/dashboard`));

    // §5: the choice is saved against the account, so an un-prefixed URL now
    // resolves to it rather than to the browser's own language.
    await page.goto('/');
    await expect(page).toHaveURL(new RegExp(`/${other}(/|$)`));
    await expectDirection(page, DIRECTION(other), other);
  });

  test('the campaign wizard states that campaigns are created paused', async ({
    page,
  }, testInfo) => {
    const locale = LOCALE(testInfo.project.name);
    await page.goto(`/${locale}/advertising`);

    // The single most important honesty claim in the product: the connected
    // workflow creates Meta objects PAUSED and never activates them. A user
    // must not believe money is being spent.
    const notice = locale === 'ar' ? /متوقفة|PAUSED/ : /paused|PAUSED/;
    await expect(page.getByText(notice).first()).toBeVisible();
  });

  test('the creative studio explains that video generation is off', async ({
    page,
  }, testInfo) => {
    const locale = LOCALE(testInfo.project.name);
    await page.goto(`/${locale}/creative`);

    // The video option is shown and explained rather than quietly missing, so
    // a user who asked for video learns why they cannot have it.
    const videoOption = page.getByRole('button', {
      name: locale === 'ar' ? 'فيديو' : 'Video',
    });
    await expect(videoOption).toBeVisible();
    await expect(videoOption).toBeDisabled();
  });

  test('campaign performance is reported unavailable, not zero', async ({ page }, testInfo) => {
    const locale = LOCALE(testInfo.project.name);
    await page.goto(`/${locale}/dashboard`);

    // §36/§52: the advertising workflow has no Insights node, so these metrics
    // are unobtainable. Zeros would read as "nobody saw this ad".
    const explanation = locale === 'ar' ? /بيانات الأداء غير متاحة/ : /Performance data is not available/;
    await expect(page.getByText(explanation).first()).toBeVisible();
  });
});

test.describe('accessibility basics', () => {
  test('a skip link is the first thing keyboard focus reaches', async ({ page }, testInfo) => {
    const locale = LOCALE(testInfo.project.name);
    await page.goto(`/${locale}/login`);

    await page.keyboard.press('Tab');

    const focused = await page.evaluate(() => ({
      tag: document.activeElement?.tagName,
      text: document.activeElement?.textContent?.trim(),
      href: document.activeElement?.getAttribute('href'),
    }));

    expect(focused.tag).toBe('A');
    expect(focused.href).toBe('#main-content');
  });

  test('every form control has an accessible name', async ({ page }, testInfo) => {
    const locale = LOCALE(testInfo.project.name);
    await page.goto(`/${locale}/register`);

    const unnamed = await page.evaluate(() => {
      const controls = Array.from(
        document.querySelectorAll('input, select, textarea'),
      ) as HTMLElement[];

      return controls
        .filter((control) => {
          if (control.getAttribute('type') === 'hidden') return false;
          const id = control.getAttribute('id');
          const hasLabel = id ? Boolean(document.querySelector(`label[for="${id}"]`)) : false;
          return (
            !hasLabel &&
            !control.getAttribute('aria-label') &&
            !control.getAttribute('aria-labelledby')
          );
        })
        .map((control) => control.outerHTML.slice(0, 80));
    });

    expect(unnamed, 'controls with no accessible name').toEqual([]);
  });

  test('the page has exactly one level-1 heading', async ({ page }, testInfo) => {
    const locale = LOCALE(testInfo.project.name);
    await page.goto(`/${locale}/login`);

    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  });
});
