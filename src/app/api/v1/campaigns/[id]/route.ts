import { route, jsonResponse } from '@/server/api/handler';
import {
  getCampaign,
  updateCampaign,
  deleteCampaign,
  reviewCampaign,
  getCampaignPerformance,
} from '@/server/services/campaign-service';
import { getAsset } from '@/server/services/asset-service';
import { AppError } from '@/lib/errors';
import { campaignDraftSchema } from '@/server/api/schemas/campaign';

function campaignId(params: Record<string, string>): string {
  const id = params.id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new AppError('not_found');
  return id;
}

export const GET = route({}, async ({ session, params, correlationId }) => {
  const id = campaignId(params);
  const campaign = await getCampaign({ organizationId: session.organizationId, campaignId: id });

  const asset = campaign.assetId
    ? await getAsset({ organizationId: session.organizationId, assetId: campaign.assetId }).catch(
        // A deleted creative should not make the campaign unreadable.
        () => undefined,
      )
    : undefined;

  const [review, performance] = await Promise.all([
    Promise.resolve(reviewCampaign(campaign, asset)),
    getCampaignPerformance({ organizationId: session.organizationId, campaignId: id }),
  ]);

  return jsonResponse(
    {
      campaign,
      asset: asset
        ? { id: asset.id, title: asset.title, kind: asset.kind, width: asset.width, height: asset.height }
        : null,
      review,
      performance,
    },
    correlationId,
  );
});

export const PATCH = route(
  { bodySchema: campaignDraftSchema.partial() },
  async ({ session, body, params, correlationId }) => {
    await updateCampaign({
      organizationId: session.organizationId,
      userId: session.userId,
      campaignId: campaignId(params),
      // `name` is required on the draft schema but optional on an update.
      input: body as Parameters<typeof updateCampaign>[0]['input'],
      correlationId,
    });

    return jsonResponse({ ok: true }, correlationId);
  },
);

export const DELETE = route({}, async ({ session, params, correlationId }) => {
  await deleteCampaign({
    organizationId: session.organizationId,
    userId: session.userId,
    campaignId: campaignId(params),
    correlationId,
  });

  return jsonResponse({ ok: true }, correlationId);
});
