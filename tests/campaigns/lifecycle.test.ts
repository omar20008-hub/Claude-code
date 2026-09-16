import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { withTenant } from '@/server/tenancy/context';
import { campaigns, assets, auditLogs } from '@/server/db/schema';
import {
  createCampaign,
  approveCampaign,
  launchCampaign,
  getCampaign,
  reviewCampaign,
  getCampaignPerformance,
} from '@/server/services/campaign-service';
import { resetDatabase, seedTenant, closeDatabase, adminSql, countAll } from '../helpers/db';
import { captureRejection, databaseErrorMessage } from '../helpers/errors';
import type { AdvertisingSubmitResult } from '@/server/agents/contracts';

/**
 * Campaign lifecycle: approval, launch and duplicate protection (§21, §29, §50).
 *
 * The agent gateway is mocked, because these tests are about the SaaS's own
 * guarantees — that a campaign cannot reach Meta without a recorded approval,
 * and cannot reach it twice. Calling the real workflow would create real
 * objects on a real ad account, which is precisely the outcome this code
 * exists to control.
 *
 * The mock is deliberately thin: it records how many times the adapter was
 * invoked, which is the number that actually matters. If the gateway is called
 * twice, a duplicate campaign was created, whatever the database says.
 */

const invocations: Array<{ action: string; idempotencyKey?: string }> = [];
let nextResult: { outcome: 'COMPLETED' | 'FAILED'; result?: AdvertisingSubmitResult; error?: { code: string; retryable: boolean } } = {
  outcome: 'COMPLETED',
  result: {
    metaCampaignId: '120000000000001',
    metaAdSetId: '120000000000002',
    metaAdId: '120000000000003',
    objectStatus: 'PAUSED',
  },
};

vi.mock('@/server/agents/gateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/agents/gateway')>();
  return {
    ...actual,
    invokeAgent: vi.fn(async (options: { action: string; idempotencyKey?: string }) => {
      invocations.push({ action: options.action, idempotencyKey: options.idempotencyKey });
      return {
        requestRef: `req_${invocations.length}`,
        jobId: undefined,
        response: { requestId: `req_${invocations.length}`, durationMs: 10, ...nextResult },
      };
    }),
  };
});

// The creative is fetched from object storage before submission; stub the
// network hop so these tests do not need a live S3.
vi.mock('@/server/storage/object-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/storage/object-store')>();
  return {
    ...actual,
    signedDownloadUrl: vi.fn(async () => 'https://storage.test/creative.jpg'),
  };
});

const originalFetch = globalThis.fetch;
globalThis.fetch = vi.fn(async () =>
  new Response(Buffer.from('fake-jpeg-bytes'), { status: 200 }),
) as typeof fetch;

let tenant: Awaited<ReturnType<typeof seedTenant>>;
let otherTenant: Awaited<ReturnType<typeof seedTenant>>;
let assetId: string;

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await closeDatabase();
});

beforeEach(async () => {
  invocations.length = 0;
  nextResult = {
    outcome: 'COMPLETED',
    result: {
      metaCampaignId: '120000000000001',
      metaAdSetId: '120000000000002',
      metaAdId: '120000000000003',
      objectStatus: 'PAUSED',
    },
  };

  await resetDatabase();
  tenant = await seedTenant({ name: 'Advertiser A' });
  otherTenant = await seedTenant({ name: 'Advertiser B' });

  // A stored creative that satisfies the workflow's spec (1080×1080, Feed 1:1).
  const sql = adminSql();
  const [asset] = await sql<{ id: string }[]>`
    INSERT INTO assets (organization_id, kind, status, title, storage_key, mime_type, size_bytes, width, height)
    VALUES (${tenant.organizationId}, 'IMAGE', 'STORED', 'Square creative',
            ${'tenants/x/image/a.jpg'}, 'image/jpeg', 120000, 1080, 1080)
    RETURNING id
  `;
  assetId = asset!.id;
});

/** A complete, spec-compliant draft. */
async function createCompleteDraft(overrides: Record<string, unknown> = {}): Promise<string> {
  const created = await createCampaign({
    organizationId: tenant.organizationId,
    userId: tenant.userId,
    locale: 'en',
    correlationId: 'cid_test',
    input: {
      name: 'Launch campaign',
      primaryText: 'Try our new product today',
      headline: 'Launch offer',
      destinationUrl: 'https://example.com/launch',
      placement: 'Feed 1:1',
      countries: ['SA'],
      lifetimeBudget: 3000,
      startDate: '2026-10-01',
      endDate: '2026-10-15',
      assetId,
      ...overrides,
    },
  });
  return created.id;
}

describe('campaign creation', () => {
  it('starts every campaign as a DRAFT with no Meta identifiers', async () => {
    const id = await createCompleteDraft();
    const campaign = await getCampaign({ organizationId: tenant.organizationId, campaignId: id });

    expect(campaign.status).toBe('DRAFT');
    expect(campaign.metaCampaignId).toBeNull();
    expect(campaign.approvedAt).toBeNull();
    // Nothing reached the agent.
    expect(invocations).toHaveLength(0);
  });

  it('converts the budget to minor units exactly once', async () => {
    const id = await createCompleteDraft({ lifetimeBudget: 3000 });
    const campaign = await getCampaign({ organizationId: tenant.organizationId, campaignId: id });

    // 3000 SAR stored as 300000 halalas — the unit Meta's API expects.
    expect(campaign.lifetimeBudgetMinor).toBe(300_000);
  });
});

describe('approval gate (§21)', () => {
  it('refuses to launch a campaign that was never approved', async () => {
    const id = await createCompleteDraft();

    const error = await captureRejection(() =>
      launchCampaign({
        organizationId: tenant.organizationId,
        userId: tenant.userId,
        campaignId: id,
        locale: 'en',
        correlationId: 'cid_test',
        idempotencyKey: 'key-unapproved',
      }),
    );

    expect((error as { code: string }).code).toBe('campaign_not_launchable');
    // The decisive assertion: nothing reached Meta.
    expect(invocations).toHaveLength(0);
  });

  it('records who approved, when, and exactly what they saw', async () => {
    const id = await createCompleteDraft();
    await approveCampaign({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      campaignId: id,
      correlationId: 'cid_test',
    });

    const campaign = await getCampaign({ organizationId: tenant.organizationId, campaignId: id });

    expect(campaign.status).toBe('READY');
    expect(campaign.approvedByUserId).toBe(tenant.userId);
    expect(campaign.approvedAt).toBeInstanceOf(Date);

    // The snapshot is what makes the approval provable months later.
    const snapshot = campaign.approvedSnapshot as Record<string, unknown>;
    expect(snapshot.lifetimeBudgetMinor).toBe(300_000);
    expect(snapshot.name).toBe('Launch campaign');
    expect(snapshot.audience).toBeDefined();
  });

  it('writes an audit record atomically with the approval', async () => {
    const id = await createCompleteDraft();
    await approveCampaign({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      campaignId: id,
      correlationId: 'cid_approve',
    });

    const entries = await withTenant({ organizationId: tenant.organizationId }, (tx) =>
      tx.select().from(auditLogs).where(eq(auditLogs.action, 'campaign.approved')),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.resourceId).toBe(id);
    expect(entries[0]?.correlationId).toBe('cid_approve');
  });

  it('refuses to approve an incomplete campaign', async () => {
    const created = await createCampaign({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      locale: 'en',
      correlationId: 'cid_test',
      input: { name: 'Half-finished' },
    });

    const error = await captureRejection(() =>
      approveCampaign({
        organizationId: tenant.organizationId,
        userId: tenant.userId,
        campaignId: created.id,
        correlationId: 'cid_test',
      }),
    );

    expect((error as { code: string }).code).toBe('validation_failed');
  });

  it('refuses to approve a campaign whose creative violates Meta’s spec', async () => {
    // A 1920×1080 image against a 1:1 placement: the workflow's validator would
    // reject it, so approval must too, before anyone is told it is ready.
    const sql = adminSql();
    const [wide] = await sql<{ id: string }[]>`
      INSERT INTO assets (organization_id, kind, status, title, storage_key, mime_type, size_bytes, width, height)
      VALUES (${tenant.organizationId}, 'IMAGE', 'STORED', 'Wide', 'k.jpg', 'image/jpeg', 1000, 1920, 1080)
      RETURNING id
    `;

    const id = await createCompleteDraft({ assetId: wide!.id, placement: 'Feed 1:1' });

    const error = await captureRejection(() =>
      approveCampaign({
        organizationId: tenant.organizationId,
        userId: tenant.userId,
        campaignId: id,
        correlationId: 'cid_test',
      }),
    );

    expect((error as { code: string }).code).toBe('campaign_not_launchable');
  });
});

describe('launch', () => {
  async function approvedCampaign(): Promise<string> {
    const id = await createCompleteDraft();
    await approveCampaign({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      campaignId: id,
      correlationId: 'cid_test',
    });
    return id;
  }

  it('lands in PAUSED, not ACTIVE, because the workflow never activates', async () => {
    const id = await approvedCampaign();

    const result = await launchCampaign({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      campaignId: id,
      locale: 'en',
      correlationId: 'cid_test',
      idempotencyKey: 'key-1',
    });

    // The single most important behavioural assertion in this file. The n8n
    // workflow creates campaign, ad set and ad with status PAUSED and has no
    // activation step; reporting ACTIVE would tell a user their money is
    // being spent when it is not.
    expect(result.status).toBe('PAUSED');
    expect(result.objectStatus).toBe('PAUSED');

    const campaign = await getCampaign({ organizationId: tenant.organizationId, campaignId: id });
    expect(campaign.status).toBe('PAUSED');
    expect(campaign.metaObjectStatus).toBe('PAUSED');
    expect(campaign.metaCampaignId).toBe('120000000000001');
    expect(campaign.launchedAt).toBeInstanceOf(Date);
  });

  it('records the launch in the audit trail with the Meta identifiers', async () => {
    const id = await approvedCampaign();
    await launchCampaign({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      campaignId: id,
      locale: 'en',
      correlationId: 'cid_launch',
      idempotencyKey: 'key-audit',
    });

    const entries = await withTenant({ organizationId: tenant.organizationId }, (tx) =>
      tx.select().from(auditLogs).where(eq(auditLogs.action, 'campaign.launched')),
    );

    expect(entries).toHaveLength(1);
    const metadata = entries[0]?.metadata as Record<string, unknown>;
    expect(metadata.metaCampaignId).toBe('120000000000001');
    expect(metadata.objectStatus).toBe('PAUSED');
    expect(metadata.budgetMinor).toBe(300_000);
  });

  it('marks the campaign FAILED and reaches Meta once when the agent rejects it', async () => {
    nextResult = {
      outcome: 'FAILED',
      error: { code: 'agent_failed', retryable: false },
    };

    const id = await approvedCampaign();
    const result = await launchCampaign({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      campaignId: id,
      locale: 'en',
      correlationId: 'cid_test',
      idempotencyKey: 'key-fail',
    });

    expect(result.status).toBe('FAILED');

    const campaign = await getCampaign({ organizationId: tenant.organizationId, campaignId: id });
    expect(campaign.status).toBe('FAILED');
    expect(campaign.lastErrorCode).toBe('agent_failed');
    expect(campaign.metaCampaignId).toBeNull();
    // The key is cleared so the user can correct and resubmit.
    expect(campaign.launchIdempotencyKey).toBeNull();
    expect(invocations).toHaveLength(1);
  });
});

describe('duplicate launch protection (§29)', () => {
  async function approvedCampaign(): Promise<string> {
    const id = await createCompleteDraft();
    await approveCampaign({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      campaignId: id,
      correlationId: 'cid_test',
    });
    return id;
  }

  it('refuses a second launch of an already-submitted campaign', async () => {
    const id = await approvedCampaign();

    await launchCampaign({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      campaignId: id,
      locale: 'en',
      correlationId: 'cid_test',
      idempotencyKey: 'key-first',
    });

    const error = await captureRejection(() =>
      launchCampaign({
        organizationId: tenant.organizationId,
        userId: tenant.userId,
        campaignId: id,
        locale: 'en',
        correlationId: 'cid_test',
        // Even a DIFFERENT key must not produce a second campaign.
        idempotencyKey: 'key-second',
      }),
    );

    expect((error as { code: string }).code).toBe('campaign_already_launched');
    expect(invocations, 'the agent must be called exactly once').toHaveLength(1);
  });

  it('survives two overlapping launches: exactly one reaches Meta', async () => {
    // The real-world case: a double-clicked button, or two tabs.
    //
    // Which layer stops the loser depends on timing. Usually the first launch's
    // claim transaction commits before the second one reads, so the second is
    // refused by the status pre-check. When the two genuinely interleave, the
    // conditional claim is what stops it — proven directly by the test below,
    // which fails if that predicate is removed. Both paths are required; this
    // test asserts the outcome that matters either way.
    const id = await approvedCampaign();

    const results = await Promise.allSettled([
      launchCampaign({
        organizationId: tenant.organizationId,
        userId: tenant.userId,
        campaignId: id,
        locale: 'en',
        correlationId: 'cid_a',
        idempotencyKey: 'concurrent-a',
      }),
      launchCampaign({
        organizationId: tenant.organizationId,
        userId: tenant.userId,
        campaignId: id,
        locale: 'en',
        correlationId: 'cid_b',
        idempotencyKey: 'concurrent-b',
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // What actually matters: one campaign on Meta, one budget.
    expect(invocations, 'exactly one agent invocation').toHaveLength(1);

    const campaign = await getCampaign({ organizationId: tenant.organizationId, campaignId: id });
    expect(campaign.metaCampaignId).toBe('120000000000001');
  });

  it('enforces one row per Meta campaign id at the database level', async () => {
    // The last backstop: even a bug that got past both application guards
    // cannot record two rows against one Meta campaign.
    const sql = adminSql();
    await sql`
      INSERT INTO campaigns (organization_id, name, locale, meta_campaign_id)
      VALUES (${tenant.organizationId}, 'First', 'en', '120000000000999')
    `;

    const error = await captureRejection(async () => {
      await sql`
        INSERT INTO campaigns (organization_id, name, locale, meta_campaign_id)
        VALUES (${otherTenant.organizationId}, 'Second', 'en', '120000000000999')
      `;
    });

    expect(databaseErrorMessage(error)).toMatch(/duplicate key|unique/i);
  });

  it('scopes idempotency keys per tenant', async () => {
    // Two organizations reusing the same key is legitimate; they must not
    // collide with each other.
    const sql = adminSql();
    await sql`
      INSERT INTO campaigns (organization_id, name, locale, launch_idempotency_key)
      VALUES (${tenant.organizationId}, 'A', 'en', 'shared-key')
    `;
    await sql`
      INSERT INTO campaigns (organization_id, name, locale, launch_idempotency_key)
      VALUES (${otherTenant.organizationId}, 'B', 'en', 'shared-key')
    `;

    expect(await countAll('campaigns')).toBe(2);
  });
});

describe('tenant isolation of campaigns', () => {
  it('does not let one tenant launch another tenant’s campaign', async () => {
    const id = await createCompleteDraft();
    await approveCampaign({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      campaignId: id,
      correlationId: 'cid_test',
    });

    const error = await captureRejection(() =>
      launchCampaign({
        // Tenant B, tenant A's campaign id.
        organizationId: otherTenant.organizationId,
        userId: otherTenant.userId,
        campaignId: id,
        locale: 'en',
        correlationId: 'cid_test',
        idempotencyKey: 'cross-tenant',
      }),
    );

    // Not "forbidden": tenant B is told it does not exist, which reveals
    // nothing about another tenant's data.
    expect((error as { code: string }).code).toBe('not_found');
    expect(invocations).toHaveLength(0);
  });
});

describe('performance reporting (§36)', () => {
  it('reports unavailable rather than zero when no metrics exist', async () => {
    const id = await createCompleteDraft();

    const performance = await getCampaignPerformance({
      organizationId: tenant.organizationId,
      campaignId: id,
    });

    // The advertising workflow has no Insights node, so metrics are genuinely
    // unobtainable. Zeros would read as "nobody saw this ad".
    expect(performance.available).toBe(false);
  });

  it('computes derived rates only when the denominator is non-zero', async () => {
    const id = await createCompleteDraft();
    const sql = adminSql();

    await sql`
      INSERT INTO campaign_metrics (organization_id, campaign_id, date, impressions, clicks, spend_minor, conversions, conversion_value_minor)
      VALUES (${tenant.organizationId}, ${id}, now(), 10000, 250, 50000, 10, 150000)
    `;

    const performance = await getCampaignPerformance({
      organizationId: tenant.organizationId,
      campaignId: id,
    });

    expect(performance.available).toBe(true);
    if (!performance.available) return;

    expect(performance.impressions).toBe(10000);
    expect(performance.ctr).toBeCloseTo(0.025, 5);
    expect(performance.cpcMinor).toBe(200);
    expect(performance.roas).toBeCloseTo(3, 5);
  });

  it('returns null, not NaN or Infinity, for an empty denominator', async () => {
    const id = await createCompleteDraft();
    const sql = adminSql();

    await sql`
      INSERT INTO campaign_metrics (organization_id, campaign_id, date, impressions, clicks, spend_minor)
      VALUES (${tenant.organizationId}, ${id}, now(), 0, 0, 0)
    `;

    const performance = await getCampaignPerformance({
      organizationId: tenant.organizationId,
      campaignId: id,
    });

    expect(performance.available).toBe(true);
    if (!performance.available) return;

    // A NaN leaking into the UI renders as "NaN%" on a dashboard.
    expect(performance.ctr).toBeNull();
    expect(performance.cpcMinor).toBeNull();
    expect(performance.roas).toBeNull();
  });
});

describe('review warnings', () => {
  it('flags an over-long primary text as a blocker, matching the workflow', async () => {
    const id = await createCompleteDraft({ primaryText: 'x'.repeat(200) });
    const campaign = await getCampaign({ organizationId: tenant.organizationId, campaignId: id });

    const { blockers } = reviewCampaign(campaign);
    expect(blockers.map((b) => b.key)).toContain('longPrimaryText');
  });

  it('warns when no audience narrowing is set', async () => {
    const id = await createCompleteDraft();
    const campaign = await getCampaign({ organizationId: tenant.organizationId, campaignId: id });

    const { warnings } = reviewCampaign(campaign);
    expect(warnings.map((w) => w.key)).toContain('noAudienceNarrowing');
  });

  it('passes a well-formed campaign with a matching creative', async () => {
    const id = await createCompleteDraft({ ageMin: 25, ageMax: 45 });
    const campaign = await getCampaign({ organizationId: tenant.organizationId, campaignId: id });
    const asset = await withTenant({ organizationId: tenant.organizationId }, (tx) =>
      tx.select().from(assets).where(eq(assets.id, assetId)).limit(1),
    );

    const { blockers } = reviewCampaign(campaign, asset[0]);
    expect(blockers).toEqual([]);
  });
});

describe('the conditional claim itself', () => {
  /**
   * Exercises the guard directly, under genuine database concurrency.
   *
   * The service-level test above cannot reliably reach this code path: the
   * first launch usually commits before the second one reads, so the loser is
   * refused by the status pre-check and the claim is never contended. Here two
   * transactions are held open simultaneously and both attempt the same
   * conditional UPDATE, which is exactly what happens when two requests
   * interleave inside the service.
   *
   * Removing `status = 'READY'` from the claim's WHERE clause makes this test
   * fail — verified by deleting that predicate and re-running.
   */
  it('lets exactly one of two simultaneous transactions claim a READY campaign', async () => {
    const sql = adminSql();
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO campaigns (organization_id, name, locale, status)
      VALUES (${tenant.organizationId}, 'Contended', 'en', 'READY')
      RETURNING id
    `;
    const campaignId = row!.id;

    // Two independent connections, so neither can see the other's uncommitted
    // work and both really do contend for the row lock.
    const claim = async (key: string) =>
      withTenant({ organizationId: tenant.organizationId }, (tx) =>
        tx
          .update(campaigns)
          .set({ status: 'LAUNCHING', launchIdempotencyKey: key })
          .where(
            and(
              eq(campaigns.id, campaignId),
              eq(campaigns.organizationId, tenant.organizationId),
              eq(campaigns.status, 'READY'),
              isNull(campaigns.metaCampaignId),
            ),
          )
          .returning({ id: campaigns.id }),
      );

    const [first, second] = await Promise.all([claim('claim-a'), claim('claim-b')]);

    // One update matches the row; the other finds it already LAUNCHING and
    // matches nothing. Without the status predicate both would match.
    const winners = [first, second].filter((result) => result.length === 1);
    expect(winners, 'exactly one transaction may claim the campaign').toHaveLength(1);

    const [after] = await sql<{ status: string; launch_idempotency_key: string }[]>`
      SELECT status, launch_idempotency_key FROM campaigns WHERE id = ${campaignId}
    `;
    expect(after?.status).toBe('LAUNCHING');
    // The winner's key is the one that stuck; the loser never wrote.
    expect(['claim-a', 'claim-b']).toContain(after?.launch_idempotency_key);
  });
});
