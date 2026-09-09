import { z } from 'zod';
import { route, jsonResponse } from '@/server/api/handler';
import { verifyEmail } from '@/server/services/auth-service';
import { POLICIES } from '@/server/security/rate-limit';

const bodySchema = z.object({
  token: z.string().min(16).max(256),
});

export const POST = route(
  { auth: false, bodySchema, rateLimit: POLICIES.emailVerification },
  async ({ body, correlationId }) => {
    await verifyEmail(body.token);
    return jsonResponse({ ok: true }, correlationId);
  },
);
