import { z } from 'zod';
import { route, jsonResponse } from '@/server/api/handler';
import { launchCampaign } from '@/server/services/campaign-service';
import { POLICIES } from '@/server/security/rate-limit';
import { AppError } from '@/lib/errors';

/**
 * Submits an approved campaign to Meta (§21, §29).
 *
 * THE HIGHEST-STAKES ENDPOINT IN THE PRODUCT. It creates objects on a real ad
 * account, so three things are non-negotiable:
 *
 *  1. `confirmed: true` must be stated explicitly.
 *  2. An `Idempotency-Key` is REQUIRED, not optional. A retried launch without
 *     one could create a second campaign and a second budget, so a request that
 *     omits it is rejected before any work happens.
 *  3. The service claims the campaign with a conditional status update, so even
 *     two simultaneous requests carrying different keys cannot both proceed.
 *
 * On success the campaign lands in PAUSED, not ACTIVE: the n8n workflow creates
 * every Meta object paused and never activates it. Reporting it as live would
 * be a fabrication.
 */
const bodySchema = z.object({
  confirmed: z.literal(true),
});

export const POST = route(
  { bodySchema, rateLimit: POLICIES.campaignLaunch },
  async ({ session, params, request, correlationId }) => {
    const id = params.id;
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new AppError('not_found');

    const idempotencyKey = request.headers.get('idempotency-key');
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw new AppError('validation_failed', {
        fields: [{ path: 'Idempotency-Key', rule: 'required' }],
        internalMessage: 'Campaign launch requires an Idempotency-Key header of 8-128 chars',
      });
    }

    const result = await launchCampaign({
      organizationId: session.organizationId,
      userId: session.userId,
      campaignId: id,
      locale: session.locale,
      correlationId,
      idempotencyKey,
    });

    // A rejected submission is a domain outcome the wizard must render with the
    // agent's reason, not a transport error.
    return jsonResponse(result, correlationId, { status: result.error ? 200 : 201 });
  },
);
