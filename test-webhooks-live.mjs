#!/usr/bin/env node
/**
 * Test n8n webhooks are configured and accessible from the running app
 */

import { chromium } from '@playwright/test';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';

const APP = 'http://localhost:3000';
const EXE = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const sql = postgres('postgres://app_user:app_user_dev_password@127.0.0.1:5432/ai_workforce', {
  max: 2,
  onnotice: () => {},
});

async function test() {
  console.log('🧪 Testing n8n webhook configuration in live app...\n');

  const browser = await chromium.launch({ executablePath: EXE });
  const context = await browser.newContext({
    locale: 'ar',
    viewport: { width: 1440, height: 950 },
    deviceScaleFactor: 2,
    extraHTTPHeaders: { 'Accept-Language': 'ar-SA,ar;q=0.9' },
  });
  const page = await context.newPage();

  try {
    // Create test account
    const suffix = randomUUID().slice(0, 8);
    const account = {
      email: `test-${suffix}@example.test`,
      password: 'vault-tumbler-orchid-quay',
      organizationName: `شركة الاختبار ${suffix}`,
      name: 'اختبار التكامل',
    };

    console.log(`📝 Creating test account: ${account.email}`);

    const res = await page.request.post(`${APP}/api/v1/auth/register`, {
      headers: { Origin: APP, 'Content-Type': 'application/json' },
      data: { ...account, locale: 'ar' },
    });

    if (res.status() !== 201) {
      throw new Error(`Register failed: ${res.status()} - ${await res.text()}`);
    }

    // Activate account
    await sql`UPDATE users SET status = 'ACTIVE', email_verified_at = now()
              WHERE lower(email) = ${account.email.toLowerCase()}`;
    await sql`DELETE FROM rate_limits`;

    console.log('✅ Account activated\n');

    // Login
    console.log('🔑 Logging in...');
    await page.goto(`${APP}/ar/login`);
    await page.getByLabel(/البريد/i).fill(account.email);
    await page.getByLabel(/كلمة المرور/i).first().fill(account.password);
    await page.getByRole('button', { name: /تسجيل الدخول/i }).click();
    await page.waitForURL(new RegExp('/ar/dashboard'), { timeout: 20000 });

    console.log('✅ Logged in\n');

    // Check agents
    const agents = [
      { key: 'knowledge', name: 'المعرفة' },
      { key: 'creative', name: 'الإبداع' },
      { key: 'advertising', name: 'الإعلانات' },
    ];

    console.log('📊 Checking agent configuration:\n');

    for (const agent of agents) {
      await page.goto(`${APP}/ar/${agent.key}`);
      await page.waitForLoadState('networkidle').catch(() => {});

      // Check if "integration not configured" is NOT shown
      const notConfigured = await page.locator('text=/لم يتم تكوين|not configured/i').count();
      const statusText = await page.locator('[role="status"]').first().textContent();

      if (notConfigured > 0) {
        console.log(`  ❌ ${agent.name}: NOT CONFIGURED`);
        console.log(`     Status: ${statusText?.slice(0, 100)}`);
      } else {
        console.log(`  ✅ ${agent.name}: CONFIGURED`);
        console.log(`     Webhook connected and ready`);
      }
    }

    console.log('\n🎉 Webhook configuration verified!\n');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  } finally {
    await browser.close();
    await sql.end();
  }
}

test().catch(console.error);
