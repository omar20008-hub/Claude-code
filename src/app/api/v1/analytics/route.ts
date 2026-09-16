import { z } from 'zod';
import { route, jsonResponse } from '@/server/api/handler';
import {
  getActivityMetrics,
  getCreativeMetrics,
  getAdvertisingMetrics,
  getRequestTimeSeries,
  unavailableMetricKeys,
} from '@/server/services/analytics-service';

const querySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  agent: z.enum(['KNOWLEDGE_AGENT', 'CREATIVE_AGENT', 'ADVERTISING_AGENT']).optional(),
  status: z.enum(['COMPLETED', 'FAILED']).optional(),
});

/**
 * Analytics (§36).
 *
 * `unavailableMetrics` is part of the contract, not an afterthought: the client
 * renders an explicit notice naming the metrics the connected integrations
 * cannot supply, instead of charting zeros that read as real measurements.
 */
export const GET = route({ querySchema }, async ({ session, query, correlationId }) => {
  const [activity, creative, advertising, series] = await Promise.all([
    getActivityMetrics(session.organizationId),
    getCreativeMetrics(session.organizationId),
    getAdvertisingMetrics(session.organizationId),
    getRequestTimeSeries(session.organizationId, query),
  ]);

  return jsonResponse(
    {
      activity,
      creative: {
        imagesGenerated: creative.imagesGenerated,
        videosGenerated: creative.videosGenerated,
        successRate: creative.successRate,
        averageProcessingMs: creative.averageProcessingMs,
        storage: creative.storage,
        videoUnavailableReasonKey: creative.videoUnavailableReasonKey,
      },
      advertising,
      series,
      unavailableMetrics: unavailableMetricKeys(),
    },
    correlationId,
  );
});
