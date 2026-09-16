import { and, eq, gte, isNull, lte, sql, desc, type SQL } from 'drizzle-orm';
import { withTenant } from '@/server/tenancy/context';
import {
  agentRequests,
  agentJobs,
  assets,
  campaigns,
  campaignMetrics,
  conversations,
  messages,
  systemEvents,
  integrations,
} from '@/server/db/schema';
import { getKnowledgeSourceStatus } from './knowledge-service';
import { getStorageUsage } from './asset-service';
import { allCapabilities } from '@/server/agents/gateway';
import { probeN8n } from '@/server/agents/n8n-client';
import { probeStorage } from '@/server/storage/object-store';
import { isN8nConfigured, isStorageConfigured } from '@/server/config/env';
import type { AgentName } from '@/server/agents/contracts';

/**
 * Dashboard and analytics aggregation (§13, §36).
 *
 * Everything returned here is computed from rows this platform actually wrote.
 * Where a number cannot be known — Meta impressions, indexed document counts —
 * the shape carries an explicit "unavailable" marker rather than a zero, so the
 * UI can say why instead of implying the answer is nought (§52).
 */

export interface MetricUnavailable {
  available: false;
  /** i18n key explaining why. */
  reasonKey: string;
}

export type MetricValue<T> = ({ available: true } & T) | MetricUnavailable;

export interface ActivityMetrics {
  total: number;
  today: number;
  thisWeek: number;
  thisMonth: number;
  successful: number;
  failed: number;
  averageProcessingMs: number | null;
  byAgent: Array<{ agent: AgentName; count: number; successRate: number | null }>;
}

/**
 * Overall AI activity.
 *
 * One pass over agent_requests using FILTER aggregates rather than several
 * round trips — the dashboard renders five tiles from a single scan.
 */
export async function getActivityMetrics(organizationId: string): Promise<ActivityMetrics> {
  return withTenant({ organizationId }, async (tx) => {
    const totals = await tx
      .select({
        total: sql<number>`count(*)::int`,
        today: sql<number>`count(*) FILTER (WHERE ${agentRequests.createdAt} >= date_trunc('day', now()))::int`,
        thisWeek: sql<number>`count(*) FILTER (WHERE ${agentRequests.createdAt} >= date_trunc('week', now()))::int`,
        thisMonth: sql<number>`count(*) FILTER (WHERE ${agentRequests.createdAt} >= date_trunc('month', now()))::int`,
        successful: sql<number>`count(*) FILTER (WHERE ${agentRequests.status} = 'COMPLETED')::int`,
        failed: sql<number>`count(*) FILTER (WHERE ${agentRequests.status} = 'FAILED')::int`,
        avgMs: sql<number | null>`avg(${agentRequests.durationMs}) FILTER (WHERE ${agentRequests.status} = 'COMPLETED')`,
      })
      .from(agentRequests)
      .where(eq(agentRequests.organizationId, organizationId));

    const perAgent = await tx
      .select({
        agent: agentRequests.agent,
        count: sql<number>`count(*)::int`,
        successful: sql<number>`count(*) FILTER (WHERE ${agentRequests.status} = 'COMPLETED')::int`,
      })
      .from(agentRequests)
      .where(eq(agentRequests.organizationId, organizationId))
      .groupBy(agentRequests.agent);

    const row = totals[0];

    return {
      total: row?.total ?? 0,
      today: row?.today ?? 0,
      thisWeek: row?.thisWeek ?? 0,
      thisMonth: row?.thisMonth ?? 0,
      successful: row?.successful ?? 0,
      failed: row?.failed ?? 0,
      averageProcessingMs: row?.avgMs === null || row?.avgMs === undefined ? null : Math.round(Number(row.avgMs)),
      byAgent: perAgent.map((entry) => ({
        agent: entry.agent as AgentName,
        count: entry.count,
        // null, not 0, when there is nothing to divide by.
        successRate: entry.count > 0 ? entry.successful / entry.count : null,
      })),
    };
  });
}

export interface KnowledgeMetrics {
  questionsAsked: number;
  questionsAnswered: number;
  conversationCount: number;
  recentQuestions: Array<{ id: string; content: string; createdAt: Date; conversationId: string }>;
  source: Awaited<ReturnType<typeof getKnowledgeSourceStatus>>;
}

export async function getKnowledgeMetrics(organizationId: string): Promise<KnowledgeMetrics> {
  const [counts, source] = await Promise.all([
    withTenant({ organizationId }, async (tx) => {
      const totals = await tx
        .select({
          asked: sql<number>`count(*) FILTER (WHERE ${messages.role} = 'USER')::int`,
          // "Answered" means an assistant turn was actually persisted, which
          // only happens on a successful agent call.
          answered: sql<number>`count(*) FILTER (WHERE ${messages.role} = 'ASSISTANT')::int`,
        })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(
          and(
            eq(messages.organizationId, organizationId),
            eq(conversations.agent, 'KNOWLEDGE_AGENT'),
            isNull(conversations.deletedAt),
          ),
        );

      const conversationCount = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(conversations)
        .where(
          and(
            eq(conversations.organizationId, organizationId),
            eq(conversations.agent, 'KNOWLEDGE_AGENT'),
            isNull(conversations.deletedAt),
          ),
        );

      const recent = await tx
        .select({
          id: messages.id,
          content: messages.content,
          createdAt: messages.createdAt,
          conversationId: messages.conversationId,
        })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(
          and(
            eq(messages.organizationId, organizationId),
            eq(messages.role, 'USER'),
            isNull(conversations.deletedAt),
          ),
        )
        .orderBy(desc(messages.createdAt))
        .limit(5);

      return {
        questionsAsked: totals[0]?.asked ?? 0,
        questionsAnswered: totals[0]?.answered ?? 0,
        conversationCount: conversationCount[0]?.count ?? 0,
        recentQuestions: recent,
      };
    }),
    getKnowledgeSourceStatus(organizationId),
  ]);

  return { ...counts, source };
}

export interface CreativeMetrics {
  imagesGenerated: number;
  videosGenerated: number;
  successRate: number | null;
  averageProcessingMs: number | null;
  storage: Awaited<ReturnType<typeof getStorageUsage>>;
  recentAssets: Array<{ id: string; title: string; kind: 'IMAGE' | 'VIDEO'; createdAt: Date }>;
  /** Set because the connected workflow cannot produce video at all. */
  videoUnavailableReasonKey?: string;
}

export async function getCreativeMetrics(organizationId: string): Promise<CreativeMetrics> {
  const capabilities = allCapabilities().find((c) => c.agent === 'CREATIVE_AGENT');
  const videoUnavailable = capabilities?.unavailable.find(
    (u) => u.capability === 'video_generation',
  );

  const [data, storage] = await Promise.all([
    withTenant({ organizationId }, async (tx) => {
      const counts = await tx
        .select({
          images: sql<number>`count(*) FILTER (WHERE ${assets.kind} = 'IMAGE')::int`,
          videos: sql<number>`count(*) FILTER (WHERE ${assets.kind} = 'VIDEO')::int`,
        })
        .from(assets)
        .where(and(eq(assets.organizationId, organizationId), isNull(assets.deletedAt)));

      const jobs = await tx
        .select({
          total: sql<number>`count(*)::int`,
          completed: sql<number>`count(*) FILTER (WHERE ${agentJobs.status} = 'COMPLETED')::int`,
          avgMs: sql<number | null>`avg(EXTRACT(EPOCH FROM (${agentJobs.completedAt} - ${agentJobs.startedAt})) * 1000) FILTER (WHERE ${agentJobs.status} = 'COMPLETED')`,
        })
        .from(agentJobs)
        .where(
          and(
            eq(agentJobs.organizationId, organizationId),
            eq(agentJobs.agent, 'CREATIVE_AGENT'),
          ),
        );

      const recent = await tx
        .select({
          id: assets.id,
          title: assets.title,
          kind: assets.kind,
          createdAt: assets.createdAt,
        })
        .from(assets)
        .where(and(eq(assets.organizationId, organizationId), isNull(assets.deletedAt)))
        .orderBy(desc(assets.createdAt))
        .limit(6);

      const jobRow = jobs[0];

      return {
        imagesGenerated: counts[0]?.images ?? 0,
        videosGenerated: counts[0]?.videos ?? 0,
        successRate:
          jobRow && jobRow.total > 0 ? jobRow.completed / jobRow.total : null,
        averageProcessingMs:
          jobRow?.avgMs === null || jobRow?.avgMs === undefined
            ? null
            : Math.round(Number(jobRow.avgMs)),
        recentAssets: recent as CreativeMetrics['recentAssets'],
      };
    }),
    getStorageUsage(organizationId),
  ]);

  return {
    ...data,
    storage,
    videoUnavailableReasonKey: videoUnavailable?.reasonKey,
  };
}

export interface AdvertisingMetrics {
  created: number;
  submitted: number;
  active: number;
  paused: number;
  draft: number;
  failed: number;
  /**
   * Spend, impressions, clicks and derived rates. Unavailable while
   * campaign_metrics is empty, which is the current state — the advertising
   * workflow has no Insights node.
   */
  performance: MetricValue<{
    spendMinor: number;
    impressions: number;
    clicks: number;
    conversions: number;
    ctr: number | null;
    cpcMinor: number | null;
    roas: number | null;
  }>;
}

export async function getAdvertisingMetrics(
  organizationId: string,
): Promise<AdvertisingMetrics> {
  return withTenant({ organizationId }, async (tx) => {
    const counts = await tx
      .select({
        created: sql<number>`count(*)::int`,
        submitted: sql<number>`count(*) FILTER (WHERE ${campaigns.metaCampaignId} IS NOT NULL)::int`,
        active: sql<number>`count(*) FILTER (WHERE ${campaigns.status} = 'ACTIVE')::int`,
        paused: sql<number>`count(*) FILTER (WHERE ${campaigns.status} = 'PAUSED')::int`,
        draft: sql<number>`count(*) FILTER (WHERE ${campaigns.status} = 'DRAFT')::int`,
        failed: sql<number>`count(*) FILTER (WHERE ${campaigns.status} = 'FAILED')::int`,
      })
      .from(campaigns)
      .where(and(eq(campaigns.organizationId, organizationId), isNull(campaigns.deletedAt)));

    const totals = await tx
      .select({
        rowCount: sql<number>`count(*)::int`,
        spendMinor: sql<number>`COALESCE(sum(${campaignMetrics.spendMinor}), 0)::bigint`,
        impressions: sql<number>`COALESCE(sum(${campaignMetrics.impressions}), 0)::bigint`,
        clicks: sql<number>`COALESCE(sum(${campaignMetrics.clicks}), 0)::bigint`,
        conversions: sql<number>`COALESCE(sum(${campaignMetrics.conversions}), 0)::bigint`,
        conversionValueMinor: sql<number>`COALESCE(sum(${campaignMetrics.conversionValueMinor}), 0)::bigint`,
      })
      .from(campaignMetrics)
      .where(eq(campaignMetrics.organizationId, organizationId));

    const row = counts[0];
    const metrics = totals[0];

    const performance: AdvertisingMetrics['performance'] =
      !metrics || metrics.rowCount === 0
        ? {
            available: false,
            // Names the real cause: the workflow never fetches Insights.
            reasonKey: 'campaigns.performance.unavailableBody',
          }
        : (() => {
            const impressions = Number(metrics.impressions);
            const clicks = Number(metrics.clicks);
            const spendMinor = Number(metrics.spendMinor);
            const conversionValueMinor = Number(metrics.conversionValueMinor);
            return {
              available: true as const,
              spendMinor,
              impressions,
              clicks,
              conversions: Number(metrics.conversions),
              ctr: impressions > 0 ? clicks / impressions : null,
              cpcMinor: clicks > 0 ? spendMinor / clicks : null,
              roas: spendMinor > 0 ? conversionValueMinor / spendMinor : null,
            };
          })();

    return {
      created: row?.created ?? 0,
      submitted: row?.submitted ?? 0,
      active: row?.active ?? 0,
      paused: row?.paused ?? 0,
      draft: row?.draft ?? 0,
      failed: row?.failed ?? 0,
      performance,
    };
  });
}

export interface HealthStatus {
  checks: Array<{
    key: string;
    status: 'healthy' | 'degraded' | 'down' | 'unknown';
    detail?: string;
    latencyMs?: number;
  }>;
  recentErrorCount: number;
  failedJobCount: number;
  windowHours: number;
}

/**
 * Platform health (§13).
 *
 * Probes are run concurrently and every one is allowed to fail without taking
 * the panel down: an unreachable n8n must render as "unavailable", not as a
 * 500 on the dashboard.
 */
export async function getHealthStatus(organizationId: string): Promise<HealthStatus> {
  const windowHours = 24;

  const [dbCheck, n8nProbe, storageProbe, counts] = await Promise.all([
    withTenant({ organizationId }, async (tx) => {
      const startedAt = Date.now();
      await tx.select({ ok: sql<number>`1` }).from(integrations).limit(1);
      return { latencyMs: Date.now() - startedAt };
    }).then(
      (result) => ({ ok: true, ...result }),
      (error: unknown) => ({
        ok: false,
        latencyMs: 0,
        error: error instanceof Error ? error.message : String(error),
      }),
    ),
    isN8nConfigured()
      ? probeN8n().catch(() => ({ reachable: false, latencyMs: 0, error: 'probe_failed' }))
      : Promise.resolve(null),
    isStorageConfigured()
      ? probeStorage().catch(() => ({
          configured: true,
          reachable: false,
          latencyMs: 0,
          error: 'probe_failed',
        }))
      : Promise.resolve(null),
    withTenant({ organizationId }, async (tx) => {
      const errors = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(systemEvents)
        .where(
          and(
            eq(systemEvents.organizationId, organizationId),
            eq(systemEvents.severity, 'ERROR'),
            sql`${systemEvents.createdAt} > now() - make_interval(hours => ${windowHours})`,
          ),
        );

      const failedJobs = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(agentJobs)
        .where(
          and(
            eq(agentJobs.organizationId, organizationId),
            eq(agentJobs.status, 'FAILED'),
            sql`${agentJobs.createdAt} > now() - make_interval(hours => ${windowHours})`,
          ),
        );

      return {
        recentErrorCount: errors[0]?.count ?? 0,
        failedJobCount: failedJobs[0]?.count ?? 0,
      };
    }),
  ]);

  const checks: HealthStatus['checks'] = [
    {
      key: 'database',
      status: dbCheck.ok ? 'healthy' : 'down',
      latencyMs: dbCheck.latencyMs,
    },
    {
      key: 'n8n',
      status: !n8nProbe ? 'unknown' : n8nProbe.reachable ? 'healthy' : 'down',
      detail: n8nProbe ? undefined : 'not_configured',
      latencyMs: n8nProbe?.latencyMs,
    },
    {
      key: 'storage',
      status: !storageProbe ? 'unknown' : storageProbe.reachable ? 'healthy' : 'down',
      detail: storageProbe ? undefined : 'not_configured',
      latencyMs: storageProbe?.latencyMs,
    },
  ];

  // Agent availability is a configuration fact, not a probe: an adapter with no
  // webhook id cannot be called at all.
  for (const capability of allCapabilities()) {
    checks.push({
      key:
        capability.agent === 'KNOWLEDGE_AGENT'
          ? 'knowledgeAgent'
          : capability.agent === 'CREATIVE_AGENT'
            ? 'creativeAgent'
            : 'advertisingAgent',
      status: capability.configured
        ? n8nProbe?.reachable === false
          ? 'degraded'
          : 'healthy'
        : 'unknown',
    });
  }

  return { checks, ...counts, windowHours };
}

export interface AnalyticsFilters {
  from?: Date;
  to?: Date;
  agent?: AgentName;
  status?: 'COMPLETED' | 'FAILED';
}

export interface TimeSeriesPoint {
  date: string;
  total: number;
  completed: number;
  failed: number;
}

/**
 * Daily request counts for the analytics chart.
 *
 * `generate_series` fills gaps so a day with no activity is a zero point rather
 * than a missing one — a line chart that skips empty days misrepresents a lull
 * as a straight line.
 */
export async function getRequestTimeSeries(
  organizationId: string,
  filters: AnalyticsFilters = {},
): Promise<TimeSeriesPoint[]> {
  const from = filters.from ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const to = filters.to ?? new Date();

  const conditions: SQL[] = [
    eq(agentRequests.organizationId, organizationId),
    gte(agentRequests.createdAt, from),
    lte(agentRequests.createdAt, to),
  ];
  if (filters.agent) conditions.push(eq(agentRequests.agent, filters.agent));
  if (filters.status) conditions.push(eq(agentRequests.status, filters.status));

  return withTenant({ organizationId }, async (tx) => {
    const rows = await tx
      .select({
        date: sql<string>`to_char(date_trunc('day', ${agentRequests.createdAt}), 'YYYY-MM-DD')`,
        total: sql<number>`count(*)::int`,
        completed: sql<number>`count(*) FILTER (WHERE ${agentRequests.status} = 'COMPLETED')::int`,
        failed: sql<number>`count(*) FILTER (WHERE ${agentRequests.status} = 'FAILED')::int`,
      })
      .from(agentRequests)
      .where(and(...conditions))
      .groupBy(sql`date_trunc('day', ${agentRequests.createdAt})`)
      .orderBy(sql`date_trunc('day', ${agentRequests.createdAt})`);

    const byDate = new Map(rows.map((row) => [row.date, row]));
    const series: TimeSeriesPoint[] = [];

    const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
    const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));

    while (cursor <= end) {
      const key = cursor.toISOString().slice(0, 10);
      const found = byDate.get(key);
      series.push({
        date: key,
        total: found?.total ?? 0,
        completed: found?.completed ?? 0,
        failed: found?.failed ?? 0,
      });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return series;
  });
}

/**
 * Metric names the connected integrations genuinely cannot supply.
 *
 * The analytics page renders this list as an explicit notice, which is what
 * §36 ("only display metrics actually available") requires in practice.
 */
export function unavailableMetricKeys(): string[] {
  const keys: string[] = [];
  for (const capability of allCapabilities()) {
    for (const gap of capability.unavailable) {
      if (gap.capability === 'performance_metrics') {
        keys.push(
          'dashboard.metrics.impressions',
          'dashboard.metrics.clicks',
          'dashboard.metrics.ctr',
          'dashboard.metrics.cpc',
          'dashboard.metrics.conversions',
          'dashboard.metrics.roas',
          'dashboard.metrics.adSpend',
        );
      }
      if (gap.capability === 'document_count') {
        keys.push('dashboard.metrics.documentCount');
      }
    }
  }
  return [...new Set(keys)];
}
