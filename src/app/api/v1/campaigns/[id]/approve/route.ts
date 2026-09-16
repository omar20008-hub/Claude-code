import { z } from 'zod';
import { route, jsonResponse } from '@/server/api/handler';
import { approveCampaign } from '@/server/services/campaign-service';
import { AppError } from '@/lib/errors';

/**
 * Explicit campaign approval (§21).
 *
 * `confirmed: true` is required in the body rather than inferred from the call
 * itself. Approval is a high-impact, money-adjacent action, so the intent has
 * to be stated — a stray POST cannot approve a campaign, and the audit record
 * reflects a deliberate act.
 */
const bodySchema = z.object({
  confirmed: z.literal(true),
});

export const POST = route({ bodySchema }, async ({ session, params, correlationId }) => {
  const id = params.id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new AppError('not_found');

  await approveCampaign({
    organizationId: session.organizationId,
    userId: session.userId,
    campaignId: id,
    correlationId,
  });

  return jsonResponse({ ok: true, status: 'READY' }, correlationId);
});
