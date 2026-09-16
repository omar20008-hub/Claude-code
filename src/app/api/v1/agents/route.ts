import { route, jsonResponse } from '@/server/api/handler';
import { allCapabilities } from '@/server/agents/gateway';

/**
 * Agent catalogue and honest capability reporting (§15, §52).
 *
 * Returns what each agent can and cannot do *right now*, derived from the
 * adapters rather than from UI copy. The client renders "video generation is
 * turned off" from this, so the product's claims and the workflow's actual
 * behaviour cannot drift apart.
 *
 * `reasonKey` is an i18n key, not a message: the browser localizes it.
 */
export const GET = route({}, async ({ correlationId }) => {
  const capabilities = allCapabilities();

  return jsonResponse(
    {
      agents: capabilities.map((capability) => ({
        agent: capability.agent,
        configured: capability.configured,
        supports: capability.supports,
        unavailable: capability.unavailable,
      })),
    },
    correlationId,
  );
});
