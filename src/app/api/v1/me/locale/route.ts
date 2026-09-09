import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { route, jsonResponse } from '@/server/api/handler';
import { withTenant } from '@/server/tenancy/context';
import { users } from '@/server/db/schema';
import { locales, LOCALE_COOKIE } from '@/i18n/config';

const bodySchema = z.object({
  locale: z.enum(locales),
});

/**
 * Persists the signed-in user's language preference (§5).
 *
 * The cookie already carries the choice for this browser; this makes it follow
 * the account to any other device, and gives notifications and emails a
 * language to render in when the user is not present.
 */
export const PATCH = route({ bodySchema }, async ({ session, body, correlationId }) => {
  await withTenant(
    { organizationId: session.organizationId, userId: session.userId },
    (tx) =>
      tx
        .update(users)
        .set({ localePreference: body.locale, updatedAt: new Date() })
        .where(eq(users.id, session.userId)),
  );

  const response = jsonResponse({ locale: body.locale }, correlationId);

  // Mirrors what next-intl's switcher sets, so a signed-in user who lands on an
  // un-prefixed URL from a bookmark gets their saved language rather than
  // whatever their browser happens to advertise.
  response.cookies.set(LOCALE_COOKIE, body.locale, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
    httpOnly: false,
  });

  return response;
});
