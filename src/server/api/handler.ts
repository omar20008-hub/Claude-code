import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { AppError, toAppError, type FieldError } from '@/lib/errors';
import { correlationId as newCorrelationId } from '@/lib/ids';
import { requestLogger } from '@/server/observability/logger';
import { requireSession, type AuthenticatedSession } from '@/server/auth/session';
import { env } from '@/server/config/env';
import { clientIp, enforceRateLimit, POLICIES, type RateLimitPolicy } from '@/server/security/rate-limit';

/**
 * API route plumbing (§31, §38).
 *
 * Every `/api/v1/*` handler goes through `route()`, which guarantees:
 *  - a correlation id exists, is logged, and is returned in `X-Correlation-Id`;
 *  - authentication is enforced where declared;
 *  - the Origin of a state-changing request is checked (CSRF);
 *  - the body is validated before the handler sees it;
 *  - errors leave as `{ error: { code, reference, fields } }` and never as a
 *    stack trace or a database message.
 *
 * The response body deliberately carries a stable `code`, not a message. The
 * browser renders `errors.<code>` from its own catalogue, so an API error is
 * localized by the client that received it — which is the only way one backend
 * serves an Arabic and an English user correctly.
 */

export interface ApiErrorBody {
  error: {
    code: string;
    /** Correlation id, shown to the user as a support reference. */
    reference: string;
    /** Interpolation values for the localized message, e.g. `{ seconds: 30 }`. */
    params?: Record<string, string | number>;
    /** Per-field validation failures, each with an i18n rule key. */
    fields?: FieldError[];
  };
}

type Awaitable<T> = T | Promise<T>;

export interface RouteContext<TBody, TQuery> {
  request: NextRequest;
  /** Present when `auth: true`. */
  session: AuthenticatedSession;
  body: TBody;
  query: TQuery;
  correlationId: string;
  logger: ReturnType<typeof requestLogger>;
  ip: string;
  /** Dynamic route params, already awaited. */
  params: Record<string, string>;
}

export interface AnonymousRouteContext<TBody, TQuery>
  extends Omit<RouteContext<TBody, TQuery>, 'session'> {
  session: null;
}

interface RouteOptions<TBodySchema extends z.ZodTypeAny, TQuerySchema extends z.ZodTypeAny> {
  /** Require a valid session. Defaults to true — opt out explicitly. */
  auth?: boolean;
  bodySchema?: TBodySchema;
  querySchema?: TQuerySchema;
  /** Rate-limit bucket. Subject is the user id when authenticated, else the IP. */
  rateLimit?: RateLimitPolicy;
  /**
   * Skip the Origin check. Only for endpoints authenticated by something other
   * than a cookie — the n8n callback, which uses an HMAC signature.
   */
  skipOriginCheck?: boolean;
  /** Reject bodies larger than this. Defaults to 1 MiB. */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/** Methods that change state and therefore need CSRF protection. */
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Origin-based CSRF defence, layered on top of the SameSite=Lax cookie.
 *
 * SameSite already blocks the classic cross-site form POST. This catches the
 * residual cases — a same-site-but-different-origin page, a browser that
 * mishandles the attribute — by requiring the declared origin to match the
 * app's own. A state-changing request with no Origin header at all is refused
 * rather than allowed, because every browser sends one on CORS-relevant
 * methods.
 */
function assertSameOrigin(request: NextRequest): void {
  if (!STATE_CHANGING.has(request.method)) return;

  const origin = request.headers.get('origin');
  const expected = new URL(env().APP_URL).origin;

  if (origin) {
    if (origin !== expected) {
      throw new AppError('forbidden', {
        internalMessage: `Cross-origin ${request.method} rejected: origin ${origin} != ${expected}`,
      });
    }
    return;
  }

  // No Origin header. Fall back to Referer, then refuse.
  const referer = request.headers.get('referer');
  if (referer) {
    try {
      if (new URL(referer).origin === expected) return;
    } catch {
      // Malformed Referer: treat as absent.
    }
  }

  throw new AppError('forbidden', {
    internalMessage: `State-changing ${request.method} with no acceptable Origin or Referer`,
  });
}

/** Maps a Zod issue onto a localizable field error. */
function toFieldError(issue: z.ZodIssue): FieldError {
  const path = issue.path.join('.');

  switch (issue.code) {
    case 'invalid_type':
      return issue.received === 'undefined' || issue.received === 'null'
        ? { path, rule: 'required' }
        : { path, rule: 'invalid' };
    case 'too_small':
      return issue.type === 'string'
        ? { path, rule: 'too_short', params: { min: Number(issue.minimum) } }
        : { path, rule: 'too_small', params: { min: Number(issue.minimum) } };
    case 'too_big':
      return issue.type === 'string'
        ? { path, rule: 'too_long', params: { max: Number(issue.maximum) } }
        : { path, rule: 'too_big', params: { max: Number(issue.maximum) } };
    case 'invalid_string':
      if (issue.validation === 'email') return { path, rule: 'email' };
      if (issue.validation === 'url') return { path, rule: 'url' };
      return { path, rule: 'invalid' };
    case 'invalid_enum_value':
      return { path, rule: 'not_an_option' };
    case 'custom':
      // A refinement can name its own rule key via `message`.
      return { path, rule: issue.message || 'invalid' };
    default:
      return { path, rule: 'invalid' };
  }
}

function errorResponse(error: AppError, correlationId: string): NextResponse<ApiErrorBody> {
  const body: ApiErrorBody = {
    error: {
      code: error.code,
      reference: correlationId,
      ...(error.params ? { params: error.params } : {}),
      ...(error.fields ? { fields: error.fields } : {}),
    },
  };

  const headers: Record<string, string> = {
    'X-Correlation-Id': correlationId,
    'Cache-Control': 'no-store',
  };
  if (error.code === 'rate_limited' && typeof error.params?.seconds === 'number') {
    headers['Retry-After'] = String(error.params.seconds);
  }

  return NextResponse.json(body, { status: error.status, headers });
}

export function jsonResponse<T>(
  data: T,
  correlationId: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): NextResponse<T> {
  return NextResponse.json(data, {
    status: init.status ?? 200,
    headers: {
      'X-Correlation-Id': correlationId,
      // Tenant data must never be cached by a shared proxy.
      'Cache-Control': 'private, no-store',
      ...init.headers,
    },
  });
}

/** Builds an authenticated route handler. */
export function route<
  TBodySchema extends z.ZodTypeAny = z.ZodUndefined,
  TQuerySchema extends z.ZodTypeAny = z.ZodUndefined,
>(
  options: RouteOptions<TBodySchema, TQuerySchema> & { auth?: true },
  handler: (
    ctx: RouteContext<z.infer<TBodySchema>, z.infer<TQuerySchema>>,
  ) => Awaitable<NextResponse | Response>,
): (request: NextRequest, segment: { params: Promise<Record<string, string>> }) => Promise<Response>;

/** Builds an anonymous route handler. */
export function route<
  TBodySchema extends z.ZodTypeAny = z.ZodUndefined,
  TQuerySchema extends z.ZodTypeAny = z.ZodUndefined,
>(
  options: RouteOptions<TBodySchema, TQuerySchema> & { auth: false },
  handler: (
    ctx: AnonymousRouteContext<z.infer<TBodySchema>, z.infer<TQuerySchema>>,
  ) => Awaitable<NextResponse | Response>,
): (request: NextRequest, segment: { params: Promise<Record<string, string>> }) => Promise<Response>;

export function route<
  TBodySchema extends z.ZodTypeAny = z.ZodUndefined,
  TQuerySchema extends z.ZodTypeAny = z.ZodUndefined,
>(
  options: RouteOptions<TBodySchema, TQuerySchema>,
  handler: (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- reconciled by the overloads above
    ctx: any,
  ) => Awaitable<NextResponse | Response>,
) {
  const requireAuth = options.auth !== false;

  return async function handleRoute(
    request: NextRequest,
    segment?: { params: Promise<Record<string, string>> },
  ): Promise<Response> {
    // Honour an inbound correlation id so a trace spans the whole call chain,
    // but only if it looks like ours — it ends up in logs and user-visible
    // error references.
    const inbound = request.headers.get('x-correlation-id');
    const correlationId =
      inbound && /^cid_[A-Za-z0-9_-]{1,32}$/.test(inbound) ? inbound : newCorrelationId();

    const ip = clientIp(request.headers);
    const log = requestLogger({
      correlationId,
      route: new URL(request.url).pathname,
      method: request.method,
    });

    try {
      if (!options.skipOriginCheck) assertSameOrigin(request);

      let session: AuthenticatedSession | null = null;
      if (requireAuth) {
        session = await requireSession();
      }

      if (options.rateLimit) {
        await enforceRateLimit(options.rateLimit, session ? `user:${session.userId}` : `ip:${ip}`);
      } else if (requireAuth) {
        await enforceRateLimit(POLICIES.api, `user:${session!.userId}`);
      }

      // --- Body ------------------------------------------------------------
      let body: unknown = undefined;
      if (options.bodySchema && request.method !== 'GET' && request.method !== 'HEAD') {
        const declaredLength = Number(request.headers.get('content-length') ?? '0');
        const maxBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
        if (declaredLength > maxBytes) {
          throw new AppError('payload_too_large', {
            params: { max: `${Math.floor(maxBytes / 1024)} KB` },
            internalMessage: `Declared body ${declaredLength} exceeds ${maxBytes}`,
          });
        }

        const raw = await request.text();
        // Guard against a lying Content-Length.
        if (raw.length > maxBytes) {
          throw new AppError('payload_too_large', {
            params: { max: `${Math.floor(maxBytes / 1024)} KB` },
            internalMessage: `Actual body ${raw.length} exceeds ${maxBytes}`,
          });
        }

        let parsedJson: unknown;
        try {
          parsedJson = raw.length > 0 ? JSON.parse(raw) : {};
        } catch {
          throw new AppError('validation_failed', {
            internalMessage: 'Request body is not valid JSON',
          });
        }

        const parsed = options.bodySchema.safeParse(parsedJson);
        if (!parsed.success) {
          throw new AppError('validation_failed', {
            fields: parsed.error.issues.map(toFieldError),
          });
        }
        body = parsed.data;
      }

      // --- Query -----------------------------------------------------------
      let query: unknown = undefined;
      if (options.querySchema) {
        const searchParams = new URL(request.url).searchParams;
        const raw: Record<string, string | string[]> = {};
        for (const key of new Set(searchParams.keys())) {
          const values = searchParams.getAll(key);
          raw[key] = values.length > 1 ? values : (values[0] as string);
        }

        const parsed = options.querySchema.safeParse(raw);
        if (!parsed.success) {
          throw new AppError('validation_failed', {
            fields: parsed.error.issues.map(toFieldError),
          });
        }
        query = parsed.data;
      }

      const params = segment?.params ? await segment.params : {};

      const response = await handler({
        request,
        session,
        body,
        query,
        correlationId,
        logger: session
          ? log.child({ tenantId: session.organizationId, userId: session.userId })
          : log,
        ip,
        params,
      });

      if (!response.headers.get('X-Correlation-Id')) {
        response.headers.set('X-Correlation-Id', correlationId);
      }
      return response;
    } catch (error) {
      const appError = toAppError(error);

      if (appError.isExpected) {
        log.warn(
          { code: appError.code, detail: appError.internalMessage },
          'request rejected',
        );
      } else {
        log.error(
          {
            code: appError.code,
            detail: appError.internalMessage,
            stack: appError.cause instanceof Error ? appError.cause.stack : undefined,
          },
          'request failed',
        );
      }

      return errorResponse(appError, correlationId);
    }
  };
}
