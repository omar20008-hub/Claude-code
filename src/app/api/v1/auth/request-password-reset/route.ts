import { z } from 'zod';
import { route, jsonResponse } from '@/server/api/handler';
import { requestPasswordReset } from '@/server/services/auth-service';
import { POLICIES } from '@/server/security/rate-limit';
import { locales } from '@/i18n/config';

const bodySchema = z.object({
  email: z.string().trim().email().max(254),
  locale: z.enum(locales),
});

export const POST = route(
  { auth: false, bodySchema, rateLimit: POLICIES.passwordReset },
  async ({ body, ip, correlationId }) => {
    await requestPasswordReset({
      email: body.email,
      locale: body.locale,
      correlationId,
      ipAddress: ip,
    });

    // Always 200 with the same body, whether or not the address exists.
    // Anything else turns this endpoint into an account-enumeration oracle.
    return jsonResponse({ ok: true }, correlationId);
  },
);
