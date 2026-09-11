import { z } from 'zod';
import { route, jsonResponse } from '@/server/api/handler';
import { listAssets, generateAsset } from '@/server/services/asset-service';
import { POLICIES } from '@/server/security/rate-limit';
import { CREATIVE_ASPECT_RATIOS } from '@/server/agents/contracts';

const querySchema = z.object({
  kind: z.enum(['IMAGE', 'VIDEO']).optional(),
  search: z.string().max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  sort: z.enum(['newest', 'oldest', 'largest', 'titleAsc']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const GET = route({ querySchema }, async ({ session, query, correlationId }) => {
  const result = await listAssets({ organizationId: session.organizationId, ...query });
  return jsonResponse(result, correlationId);
});

const generateSchema = z.object({
  prompt: z.string().trim().min(3).max(2000),
  mediaType: z.enum(['IMAGE', 'VIDEO']),
  aspectRatio: z.enum(CREATIVE_ASPECT_RATIOS).default('16:9'),
});

/**
 * Runs a generation.
 *
 * The `Idempotency-Key` header is honoured so a retried request — a flaky
 * network, a double-clicked button — returns the original job instead of
 * paying for a second generation (§29).
 */
export const POST = route(
  { bodySchema: generateSchema, rateLimit: POLICIES.agentInvocation },
  async ({ session, body, request, correlationId }) => {
    const idempotencyKey = request.headers.get('idempotency-key') ?? undefined;

    const result = await generateAsset({
      organizationId: session.organizationId,
      userId: session.userId,
      prompt: body.prompt,
      mediaType: body.mediaType,
      aspectRatio: body.aspectRatio,
      locale: session.locale,
      correlationId,
      idempotencyKey: idempotencyKey?.slice(0, 128),
    });

    // A generation failure is reported in-band: the job row exists and the UI
    // needs to show it as failed with a retry, not receive a bare 5xx.
    return jsonResponse(result, correlationId, { status: result.error ? 200 : 201 });
  },
);
