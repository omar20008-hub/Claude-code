import { env, isN8nConfigured } from '@/server/config/env';
import { AppError } from '@/lib/errors';
import { logger } from '@/server/observability/logger';

/**
 * n8n chat-trigger transport.
 *
 * DISCOVERED CONTRACT (see docs/n8n-integration.md for the full write-up).
 * All three production workflows are `@n8n/n8n-nodes-langchain.chatTrigger`
 * nodes, not JSON REST webhooks. That has consequences this module exists to
 * contain:
 *
 *  - The endpoint is `POST {base}/webhook/{webhookId}/chat`.
 *  - The body is the hosted-chat envelope: `{ action, sessionId, chatInput }`,
 *    optionally with `files`.
 *  - There is no request id, no execution id in the response, and no callback.
 *    Correlation is therefore ours to maintain, and `n8nExecutionId` is left
 *    null rather than invented.
 *  - Three different response modes are in play:
 *      `lastNode`       -> a single JSON object, `{ output: "..." }`
 *      `streaming`      -> newline-delimited JSON chunks (Knowledge)
 *      `responseNodes`  -> a stream of frames, one per "Respond to Chat" node
 *                          (Creative, Advertising)
 *    `readChatResponse` normalizes all three into an ordered list of messages.
 *
 * Nothing here fabricates a response. When n8n is unreachable or returns an
 * error, that surfaces as a typed failure (§52).
 */

export interface N8nChatFile {
  name: string;
  type: string;
  /** Raw base64, without a data: prefix. */
  data: string;
}

export interface N8nChatRequest {
  webhookId: string;
  sessionId: string;
  chatInput: string;
  files?: N8nChatFile[];
  correlationId: string;
  timeoutMs?: number;
}

/** One logical message emitted by the workflow. */
export interface N8nChatMessage {
  /** Concatenated text of this frame. */
  text: string;
  /** Frame type as reported by n8n, when it says. */
  type?: string;
  /** Node that produced it, for `responseNodes` mode. */
  nodeName?: string;
  /** Anything else the frame carried, kept for adapters to mine. */
  raw?: unknown;
}

export interface N8nChatResponse {
  messages: N8nChatMessage[];
  /** All message text joined with blank lines. The common case for adapters. */
  text: string;
  /** Populated only if n8n actually returned one. */
  executionId?: string;
  durationMs: number;
  /** HTTP status, for diagnostics. */
  status: number;
}

function chatUrl(webhookId: string): string {
  const base = env().N8N_BASE_URL?.replace(/\/+$/, '');
  if (!base) {
    throw new AppError('integration_not_configured', {
      internalMessage: 'N8N_BASE_URL is not set',
    });
  }
  // Guard against a webhook id smuggling a path segment.
  if (!/^[A-Za-z0-9_-]+$/.test(webhookId)) {
    throw new AppError('integration_not_configured', {
      internalMessage: `Malformed n8n webhook id: ${webhookId}`,
    });
  }
  return `${base}/webhook/${webhookId}/chat`;
}

function authHeaders(): Record<string, string> {
  const { N8N_WEBHOOK_AUTH_HEADER, N8N_WEBHOOK_AUTH_VALUE } = env();
  if (N8N_WEBHOOK_AUTH_HEADER && N8N_WEBHOOK_AUTH_VALUE) {
    return { [N8N_WEBHOOK_AUTH_HEADER]: N8N_WEBHOOK_AUTH_VALUE };
  }
  return {};
}

/**
 * Extracts the human-readable text from one decoded stream frame.
 *
 * n8n has used several shapes across versions and response modes, so this
 * checks the known keys in order of specificity rather than assuming one.
 */
function frameText(frame: unknown): string {
  if (typeof frame === 'string') return frame;
  if (frame === null || typeof frame !== 'object') return '';

  const f = frame as Record<string, unknown>;

  // `streaming` mode: { type: 'item', content: '...' }
  if (typeof f.content === 'string') return f.content;
  // `lastNode` mode and most Respond-to-Chat frames.
  if (typeof f.output === 'string') return f.output;
  if (typeof f.text === 'string') return f.text;
  if (typeof f.message === 'string') return f.message;
  // Some agent nodes nest the payload.
  if (f.data && typeof f.data === 'object') {
    const nested = f.data as Record<string, unknown>;
    if (typeof nested.content === 'string') return nested.content;
    if (typeof nested.output === 'string') return nested.output;
    if (typeof nested.text === 'string') return nested.text;
  }
  return '';
}

/**
 * Splits a possibly-chunked body into decoded frames.
 *
 * Handles three wire shapes with one pass: a single JSON document, an NDJSON
 * stream, and an SSE-style `data:` stream. Anything that does not parse as JSON
 * is preserved as a plain text frame rather than dropped, so a workflow that
 * streams raw prose still produces an answer.
 */
export function parseChatFrames(body: string): N8nChatMessage[] {
  const trimmed = body.trim();
  if (trimmed.length === 0) return [];

  // Fast path: one complete JSON document.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      const messages = items
        .map((item) => ({
          text: frameText(item),
          type: typeof (item as Record<string, unknown>)?.type === 'string'
            ? ((item as Record<string, unknown>).type as string)
            : undefined,
          raw: item,
        }))
        .filter((m) => m.text.length > 0 || m.raw !== undefined);
      if (messages.length > 0) return messages;
    } catch {
      // Not a single document — fall through to line-by-line parsing.
    }
  }

  const messages: N8nChatMessage[] = [];

  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    // SSE framing: strip the field prefix and ignore control lines.
    let payload = line;
    if (line.startsWith('data:')) {
      payload = line.slice(5).trim();
    } else if (/^(event|id|retry):/.test(line)) {
      continue;
    }
    if (payload === '[DONE]') continue;

    if (payload.startsWith('{') || payload.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(payload);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          const record = item as Record<string, unknown>;
          messages.push({
            text: frameText(item),
            type: typeof record?.type === 'string' ? record.type : undefined,
            nodeName:
              typeof record?.nodeName === 'string' ? record.nodeName : undefined,
            raw: item,
          });
        }
        continue;
      } catch {
        // Malformed JSON line: keep the text rather than losing content.
      }
    }

    messages.push({ text: payload });
  }

  return messages;
}

/**
 * Joins streamed frames into a single answer.
 *
 * In `streaming` mode a sentence arrives as many token-sized `item` frames that
 * must be concatenated with no separator. In `responseNodes` mode each frame is
 * a whole message that should be separated by a blank line. The two are told
 * apart by frame type, because guessing wrong either mangles words together or
 * shreds a paragraph.
 */
export function joinFrames(messages: N8nChatMessage[]): string {
  const meaningful = messages.filter((m) => m.text.length > 0);
  if (meaningful.length === 0) return '';

  const isTokenStream = meaningful.some(
    (m) => m.type === 'item' || m.type === 'chunk' || m.type === 'token',
  );

  if (isTokenStream) {
    return meaningful
      .filter((m) => m.type !== 'begin' && m.type !== 'end' && m.type !== 'error')
      .map((m) => m.text)
      .join('')
      .trim();
  }

  return meaningful.map((m) => m.text.trim()).filter(Boolean).join('\n\n').trim();
}

/**
 * Posts one message to a chat-trigger workflow and reads the whole response.
 *
 * The generation workflows legitimately take minutes, so the timeout defaults
 * to N8N_REQUEST_TIMEOUT_MS (5 minutes) and is enforced with an AbortSignal
 * rather than left to the platform's default.
 */
export async function sendChatMessage(
  request: N8nChatRequest,
): Promise<N8nChatResponse> {
  if (!isN8nConfigured()) {
    throw new AppError('integration_not_configured', {
      internalMessage: 'n8n gateway called while N8N_BASE_URL is unset',
    });
  }

  const url = chatUrl(request.webhookId);
  const timeoutMs = request.timeoutMs ?? env().N8N_REQUEST_TIMEOUT_MS;
  const startedAt = Date.now();

  const body: Record<string, unknown> = {
    action: 'sendMessage',
    sessionId: request.sessionId,
    chatInput: request.chatInput,
  };
  if (request.files && request.files.length > 0) {
    body.files = request.files;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream, text/plain',
        // Lets an operator find the n8n execution that matches a SaaS request
        // even though the workflow never returns its id.
        'X-Correlation-Id': request.correlationId,
        ...authHeaders(),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      // n8n is an internal service; never follow a redirect to somewhere else.
      redirect: 'error',
      cache: 'no-store',
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const aborted = controller.signal.aborted;

    logger.warn(
      {
        correlationId: request.correlationId,
        webhookId: request.webhookId,
        durationMs,
        aborted,
      },
      'n8n chat request failed at the transport layer',
    );

    throw new AppError(aborted ? 'agent_timeout' : 'agent_unavailable', {
      internalMessage: aborted
        ? `n8n call exceeded ${timeoutMs}ms`
        : `n8n fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  const durationMs = Date.now() - startedAt;

  if (!response.ok) {
    logger.warn(
      {
        correlationId: request.correlationId,
        webhookId: request.webhookId,
        status: response.status,
        durationMs,
      },
      'n8n chat request returned a non-2xx status',
    );

    throw new AppError(response.status >= 500 ? 'agent_failed' : 'agent_unavailable', {
      internalMessage: `n8n responded ${response.status}: ${text.slice(0, 500)}`,
    });
  }

  const messages = parseChatFrames(text);

  return {
    messages,
    text: joinFrames(messages),
    // n8n exposes this header on some deployments; absent on the chat webhook.
    executionId:
      response.headers.get('x-n8n-execution-id') ??
      response.headers.get('execution-id') ??
      undefined,
    durationMs,
    status: response.status,
  };
}

/**
 * Liveness probe for the health panel.
 *
 * n8n answers a GET on a chat webhook with 404/405 rather than 200 — either
 * proves the instance is up and routing, which is all we claim. A network-level
 * failure is what marks the gateway down.
 */
export async function probeN8n(timeoutMs = 5000): Promise<{
  reachable: boolean;
  status?: number;
  latencyMs: number;
  error?: string;
}> {
  const base = env().N8N_BASE_URL?.replace(/\/+$/, '');
  if (!base) return { reachable: false, latencyMs: 0, error: 'not_configured' };

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${base}/healthz`, {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
      headers: authHeaders(),
    });
    return {
      reachable: true,
      status: response.status,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      reachable: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
