import { z } from 'zod';
import { route, jsonResponse } from '@/server/api/handler';
import { resetPassword } from '@/server/services/auth-service';
import { POLICIES } from '@/server/security/rate-limit';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/server/auth/password';

const bodySchema = z.object({
  token: z.string().min(16).max(256),
  newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
});

export const POST = route(
  { auth: false, bodySchema, rateLimit: POLICIES.passwordReset },
  async ({ body, ip, correlationId }) => {
    await resetPassword({
      token: body.token,
      newPassword: body.newPassword,
      correlationId,
      ipAddress: ip,
    });

    return jsonResponse({ ok: true }, correlationId);
  },
);
