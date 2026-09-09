import { z } from 'zod';
import { route, jsonResponse } from '@/server/api/handler';
import { listCampaigns, createCampaign } from '@/server/services/campaign-service';
import { campaignDraftSchema } from '@/server/api/schemas/campaign';

const querySchema = z.object({
  status: z
    .enum(['DRAFT', 'READY', 'LAUNCHING', 'ACTIVE', 'PAUSED', 'COMPLETED', 'FAILED'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const GET = route({ querySchema }, async ({ session, query, correlationId }) => {
  const result = await listCampaigns({ organizationId: session.organizationId, ...query });

  return jsonResponse(
    {
      items: result.items.map((row) => ({
        ...row.campaign,
        assetTitle: row.assetTitle,
        createdByName: row.createdByName,
      })),
      total: result.total,
    },
    correlationId,
  );
});


export const POST = route(
  { bodySchema: campaignDraftSchema },
  async ({ session, body, correlationId }) => {
    const created = await createCampaign({
      organizationId: session.organizationId,
      userId: session.userId,
      locale: session.locale,
      input: body,
      correlationId,
    });

    return jsonResponse(created, correlationId, { status: 201 });
  },
);
