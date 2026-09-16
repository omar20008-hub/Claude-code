import { randomUUID, randomBytes } from 'node:crypto';

/** Primary keys. Postgres also defaults these, but generating in the app lets
 *  us log an id before the INSERT lands. */
export function uuid(): string {
  return randomUUID();
}

/**
 * Correlation id: one per inbound HTTP request, propagated to the agent
 * gateway, stored on agent_requests/agent_jobs/audit_logs, echoed back to the
 * browser in `X-Correlation-Id`, and shown to the user as the support
 * reference on an error screen.
 *
 * Prefixed and short enough that a person can read it off a screen and quote
 * it in a support ticket.
 */
export function correlationId(): string {
  return `cid_${randomBytes(9).toString('base64url')}`;
}

/** Opaque, high-entropy token for sessions and single-use links. */
export function secureToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Stable identifier for an agent invocation, carried end to end:
 * SaaS -> gateway -> n8n -> callback. Used for idempotent callback handling.
 */
export function requestId(): string {
  return `req_${randomBytes(12).toString('base64url')}`;
}
