import { z } from 'zod';
import { route, jsonResponse } from '@/server/api/handler';
import { changePassword } from '@/server/services/auth-service';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/lib/password-policy';
import { POLICIES } from '@/server/security/rate-limit';

const bodySchema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
});

/**
 * Changes the signed-in user's password.
 *
 * Verifying the current password matters even though the caller already holds a
 * valid session: it is what stops someone who borrowed an unlocked laptop from
 * taking the account over. On success every session is revoked, including this
 * one, so a stolen session cannot outlive the change.
 */
export const PATCH = route(
  { bodySchema, rateLimit: POLICIES.passwordReset },
  async ({ session, body, correlationId }) => {
    await changePassword({
      userId: session.userId,
      organizationId: session.organizationId,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      correlationId,
    });

    return jsonResponse({ ok: true, sessionsRevoked: true }, correlationId);
  },
);
