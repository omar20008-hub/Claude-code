import { z } from 'zod';
import { route, jsonResponse } from '@/server/api/handler';
import { login } from '@/server/services/auth-service';
import { enforceRateLimit, POLICIES } from '@/server/security/rate-limit';

const bodySchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(256),
});

export const POST = route(
  {
    auth: false,
    bodySchema,
    // Per-IP limit. The per-account limit is applied below, because it needs
    // the submitted address.
    rateLimit: POLICIES.login,
  },
  async ({ body, ip, request, correlationId }) => {
    // Two independent buckets. An IP limit alone lets a botnet spread an attack
    // across addresses; an account limit alone lets one host enumerate many
    // accounts cheaply. Both are needed.
    await enforceRateLimit(POLICIES.loginPerAccount, `email:${body.email.toLowerCase()}`);

    const result = await login({
      email: body.email,
      password: body.password,
      ipAddress: ip,
      userAgent: request.headers.get('user-agent') ?? undefined,
      correlationId,
    });

    // The session cookie is set inside `login`. The body carries only what the
    // client needs to route the user to the right locale.
    return jsonResponse({ locale: result.locale }, correlationId);
  },
);
