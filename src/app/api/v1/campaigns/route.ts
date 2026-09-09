import { z } from 'zod';
import { route, jsonResponse } from '@/server/api/handler';
import { listCampaigns, createCampaign } from '@/server/services/campaign-service';
import { META_PLACEMENTS } from '@/server/agents/contracts';

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

/**
 * Campaign draft schema.
 *
 * Mirrors the constraints the n8n workflow's own validator enforces, so a user
 * is told about a problem here rather than watching a submission fail
 * downstream with an Arabic error from a Code node.
 */
export const campaignDraftSchema = z.object({
  name: z.string().trim().min(1).max(200),
  brief: z.string().max(4000).optional(),
  primaryText: z.string().max(2000).optional(),
  headline: z.string().max(255).optional(),
  description: z.string().max(500).optional(),
  destinationUrl: z.string().url().optional(),
  callToAction: z.string().max(60).optional(),
  placement: z.enum(META_PLACEMENTS).optional(),
  savedAudienceId: z.string().max(64).optional(),
  savedAudienceName: z.string().max(200).optional(),
  audienceNotes: z.string().max(1000).optional(),
  ageMin: z.number().int().min(13).max(65).optional(),
  ageMax: z.number().int().min(13).max(65).optional(),
  genders: z.enum(['all', 'male', 'female']).optional(),
  countries: z.array(z.string().length(2)).max(50).optional(),
  cities: z.array(z.string().max(120)).max(100).optional(),
  /** Major units as typed; the service converts to minor units once. */
  lifetimeBudget: z.number().positive().max(10_000_000).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  assetId: z.string().uuid().optional(),
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
