import type { FieldError } from '@/lib/errors';

/**
 * Client-side handling of the API's error envelope.
 *
 * The API returns `{ error: { code, reference, params, fields } }` and never a
 * human-readable message. That is what makes one backend serve an Arabic and an
 * English user correctly: the browser looks `errors.<code>` up in its own
 * catalogue, so the language of the response is the language of the reader,
 * not of whichever server handled the request (§38).
 */

export interface ApiErrorPayload {
  code: string;
  reference: string;
  params?: Record<string, string | number>;
  fields?: FieldError[];
}

export class ApiError extends Error {
  readonly code: string;
  readonly reference: string;
  readonly params?: Record<string, string | number>;
  readonly fields?: FieldError[];
  readonly status: number;

  constructor(payload: ApiErrorPayload, status: number) {
    super(payload.code);
    this.name = 'ApiError';
    this.code = payload.code;
    this.reference = payload.reference;
    this.params = payload.params;
    this.fields = payload.fields;
    this.status = status;
  }

  /** Field errors keyed by path, for wiring into form controls. */
  fieldMap(): Record<string, FieldError> {
    const map: Record<string, FieldError> = {};
    for (const field of this.fields ?? []) {
      map[field.path] ??= field;
    }
    return map;
  }
}

/**
 * Performs a JSON request and throws a typed ApiError on failure.
 *
 * `credentials: 'same-origin'` is explicit so the session cookie travels, and
 * nothing else does.
 */
export async function apiFetch<T>(
  input: string,
  init: RequestInit = {},
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(input, {
      ...init,
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });
  } catch {
    // A transport failure never reached the server, so there is no correlation
    // id to quote back to the user.
    throw new ApiError({ code: 'network', reference: '' }, 0);
  }

  if (response.status === 204) return undefined as T;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    const payload = (body as { error?: ApiErrorPayload } | undefined)?.error;
    throw new ApiError(
      payload ?? {
        code: 'internal_error',
        reference: response.headers.get('X-Correlation-Id') ?? '',
      },
      response.status,
    );
  }

  return body as T;
}
