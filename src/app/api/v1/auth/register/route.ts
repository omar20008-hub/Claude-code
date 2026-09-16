import { z } from 'zod';
import { route, jsonResponse } from '@/server/api/handler';
import { registerOrganization } from '@/server/services/auth-service';
import { POLICIES } from '@/server/security/rate-limit';
import { locales } from '@/i18n/config';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/lib/password-policy';

const bodySchema = z.object({
  organizationName: z.string().trim().min(2).max(200),
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  locale: z.enum(locales),
});

export const POST = route(
  {
    auth: false,
    bodySchema,
    // Tight: registration creates a tenant and sends mail, so it is worth
    // abusing. Keyed on IP because there is no account yet.
    rateLimit: POLICIES.register,
  },
  async ({ body, ip, request, correlationId }) => {
    const result = await registerOrganization({
      organizationName: body.organizationName,
      name: body.name,
      email: body.email,
      password: body.password,
      locale: body.locale,
      ipAddress: ip,
      userAgent: request.headers.get('user-agent') ?? undefined,
      correlationId,
    });

    // No session is issued: the account is PENDING_VERIFICATION until the
    // emailed link is opened. Signing the user straight in would make email
    // verification decorative.
    return jsonResponse(
      { organizationId: result.organizationId, email: result.email, requiresVerification: true },
      correlationId,
      { status: 201 },
    );
  },
);
