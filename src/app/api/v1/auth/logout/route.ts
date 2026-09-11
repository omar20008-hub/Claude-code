import { route, jsonResponse } from '@/server/api/handler';
import { destroySession } from '@/server/auth/session';
import { recordAudit } from '@/server/services/audit';

export const POST = route({ auth: true }, async ({ session, correlationId, ip }) => {
  await recordAudit({
    organizationId: session.organizationId,
    userId: session.userId,
    actorEmail: session.email,
    action: 'auth.logout',
    resourceType: 'session',
    resourceId: session.sessionId,
    status: 'SUCCESS',
    correlationId,
    ipAddress: ip,
  });

  // Audited before revocation so the tenant scope used by the audit write is
  // still backed by a live session.
  await destroySession();

  return jsonResponse({ ok: true }, correlationId);
});
