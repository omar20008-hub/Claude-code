import createIntlMiddleware from 'next-intl/middleware';
import { NextResponse, type NextRequest } from 'next/server';
import { routing } from '@/i18n/routing';
import { negotiateLocale, isLocale, locales, LOCALE_COOKIE } from '@/i18n/config';

/**
 * Edge middleware.
 *
 * Responsibilities, in order:
 *  1. Resolve the locale for every page request and redirect to a prefixed URL.
 *  2. Leave API routes and static assets alone.
 *
 * Locale resolution order (§5):
 *  1. An explicit prefix in the URL — always wins, so a shared link opens in
 *     the language it was shared in.
 *  2. The AIW_LOCALE cookie, set by the language switcher and mirrored from the
 *     signed-in user's saved preference.
 *  3. Accept-Language, negotiated with q-values.
 *  4. The configured default.
 *
 * Authentication is deliberately NOT enforced here. Session validation needs a
 * database round trip, which does not belong in middleware that runs on every
 * request; the authenticated layout and the API handler both call
 * `requireSession()`, which is the single authoritative check.
 */

const intlMiddleware = createIntlMiddleware(routing);

/** Paths that must bypass locale handling entirely. */
const BYPASS = [
  '/api',
  '/_next',
  '/favicon.ico',
  '/robots.txt',
  '/sitemap.xml',
  '/manifest.webmanifest',
];

export default function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  if (BYPASS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return NextResponse.next();
  }

  const segments = pathname.split('/').filter(Boolean);
  const firstSegment = segments[0];

  // Already carries a valid locale prefix: hand straight to next-intl.
  if (isLocale(firstSegment)) {
    const response = intlMiddleware(request);
    // Lets a CDN cache the two language variants separately.
    response.headers.set('Vary', 'Accept-Language, Cookie');
    return response;
  }

  // No prefix. Choose one, preferring an explicit cookie over the browser's
  // header so a user's deliberate switch is not overridden on every navigation.
  const cookieLocale = request.cookies.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(cookieLocale)
    ? cookieLocale
    : negotiateLocale(request.headers.get('accept-language'), routing.defaultLocale);

  const url = request.nextUrl.clone();
  url.pathname = `/${locale}${pathname === '/' ? '' : pathname}`;

  const response = NextResponse.redirect(url);
  response.headers.set('Vary', 'Accept-Language, Cookie');
  return response;
}

export const config = {
  /**
   * Matches everything except API routes, Next internals and files with an
   * extension. Written as a negative lookahead so a new static asset type does
   * not silently start going through locale redirection.
   */
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\..*).*)',
  ],
};

export { locales };
