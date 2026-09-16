import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseChatFrames, joinFrames, sendChatMessage } from '@/server/agents/n8n-client';
import { resetEnvCache } from '@/server/config/env';
import { captureRejection } from '../helpers/errors';

/**
 * n8n chat transport (§51).
 *
 * The three production workflows are chat triggers running in three different
 * response modes, and each puts a different shape on the wire:
 *
 *   lastNode       -> one JSON document: { output: "..." }
 *   streaming      -> NDJSON token frames (the Knowledge agent)
 *   responseNodes  -> one frame per Respond-to-Chat node (Creative, Advertising)
 *
 * Getting the join wrong is not a cosmetic bug: concatenating whole messages
 * with no separator runs paragraphs together, and joining token frames with
 * blank lines shreds every sentence into fragments. Both are tested here.
 */

describe('frame parsing', () => {
  it('parses a single JSON document (lastNode mode)', () => {
    const frames = parseChatFrames('{"output":"The answer is 21 days."}');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.text).toBe('The answer is 21 days.');
  });

  it('parses NDJSON token frames (streaming mode)', () => {
    const body = [
      '{"type":"begin"}',
      '{"type":"item","content":"مدة "}',
      '{"type":"item","content":"الإجازة "}',
      '{"type":"item","content":"٢١ يومًا."}',
      '{"type":"end"}',
    ].join('\n');

    const frames = parseChatFrames(body);
    expect(frames).toHaveLength(5);
    expect(frames.map((f) => f.type)).toEqual(['begin', 'item', 'item', 'item', 'end']);
  });

  it('parses SSE-style framing, stripping the data: prefix', () => {
    const body = [
      'event: message',
      'data: {"type":"item","content":"Hello"}',
      'data: {"type":"item","content":" world"}',
      'data: [DONE]',
    ].join('\n');

    const frames = parseChatFrames(body);
    expect(frames.map((f) => f.text)).toEqual(['Hello', ' world']);
  });

  it('parses a JSON array of frames', () => {
    const frames = parseChatFrames('[{"output":"first"},{"output":"second"}]');
    expect(frames.map((f) => f.text)).toEqual(['first', 'second']);
  });

  it('reads the several key names n8n has used across versions', () => {
    expect(parseChatFrames('{"content":"a"}')[0]?.text).toBe('a');
    expect(parseChatFrames('{"output":"b"}')[0]?.text).toBe('b');
    expect(parseChatFrames('{"text":"c"}')[0]?.text).toBe('c');
    expect(parseChatFrames('{"message":"d"}')[0]?.text).toBe('d');
    expect(parseChatFrames('{"data":{"content":"e"}}')[0]?.text).toBe('e');
  });

  it('keeps a non-JSON line as text rather than dropping it', () => {
    // A workflow that streams raw prose must still produce an answer.
    const frames = parseChatFrames('just plain text\nsecond line');
    expect(frames.map((f) => f.text)).toEqual(['just plain text', 'second line']);
  });

  it('survives a malformed JSON line without losing the rest', () => {
    const body = ['{"type":"item","content":"good"}', '{broken json', '{"type":"item","content":"also good"}'].join('\n');
    const frames = parseChatFrames(body);
    expect(frames.map((f) => f.text)).toContain('good');
    expect(frames.map((f) => f.text)).toContain('also good');
  });

  it('returns nothing for an empty body', () => {
    expect(parseChatFrames('')).toEqual([]);
    expect(parseChatFrames('   \n  ')).toEqual([]);
  });
});

describe('frame joining', () => {
  it('concatenates token frames with no separator', () => {
    // The Knowledge agent streams a sentence as many token-sized frames.
    // Joining these with blank lines would shred every sentence.
    const frames = parseChatFrames(
      [
        '{"type":"begin"}',
        '{"type":"item","content":"مدة "}',
        '{"type":"item","content":"الإجازة "}',
        '{"type":"item","content":"٢١ يومًا."}',
        '{"type":"end"}',
      ].join('\n'),
    );

    expect(joinFrames(frames)).toBe('مدة الإجازة ٢١ يومًا.');
  });

  it('separates whole messages with a blank line', () => {
    // The Creative and Advertising workflows emit one complete message per
    // Respond-to-Chat node. Concatenating these would run them together.
    const frames = parseChatFrames(
      ['{"output":"Brief accepted."}', '{"output":"Generating now."}'].join('\n'),
    );

    expect(joinFrames(frames)).toBe('Brief accepted.\n\nGenerating now.');
  });

  it('drops stream control frames from the joined text', () => {
    const frames = parseChatFrames(
      [
        '{"type":"begin","content":"IGNORED"}',
        '{"type":"item","content":"real"}',
        '{"type":"end","content":"IGNORED"}',
      ].join('\n'),
    );

    expect(joinFrames(frames)).toBe('real');
  });

  it('returns an empty string when nothing carried text', () => {
    expect(joinFrames([])).toBe('');
    expect(joinFrames([{ text: '' }])).toBe('');
  });
});

describe('transport behaviour', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.N8N_BASE_URL = 'https://n8n.test';
    process.env.N8N_KNOWLEDGE_WEBHOOK_ID = 'bba97385-5d58-421b-b1b4-693ff678ac83';
    resetEnvCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.N8N_BASE_URL;
    delete process.env.N8N_KNOWLEDGE_WEBHOOK_ID;
    resetEnvCache();
  });

  it('posts the hosted-chat envelope the trigger expects', async () => {
    let captured: { url: string; body: unknown; headers: Headers } | undefined;

    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      captured = {
        url: String(url),
        body: JSON.parse(String(init?.body)),
        headers: new Headers(init?.headers),
      };
      return new Response('{"output":"ok"}', { status: 200 });
    }) as typeof fetch;

    await sendChatMessage({
      webhookId: 'bba97385-5d58-421b-b1b4-693ff678ac83',
      sessionId: 'aiw_session_1',
      chatInput: 'ما مدة الإجازة السنوية؟',
      correlationId: 'cid_abc',
    });

    // The exact contract discovered from the live workflows.
    expect(captured?.url).toBe(
      'https://n8n.test/webhook/bba97385-5d58-421b-b1b4-693ff678ac83/chat',
    );
    expect(captured?.body).toEqual({
      action: 'sendMessage',
      sessionId: 'aiw_session_1',
      chatInput: 'ما مدة الإجازة السنوية؟',
    });
    // Lets an operator match a SaaS request to an n8n execution even though the
    // workflow returns no execution id.
    expect(captured?.headers.get('X-Correlation-Id')).toBe('cid_abc');
  });

  it('refuses a webhook id containing a path separator', async () => {
    const error = await captureRejection(() =>
      sendChatMessage({
        // Path traversal would let a caller reach an arbitrary n8n endpoint.
        webhookId: '../../rest/workflows',
        sessionId: 's',
        chatInput: 'x',
        correlationId: 'cid',
      }),
    );

    expect((error as { code: string }).code).toBe('integration_not_configured');
  });

  it('reports a timeout distinctly from an outage', async () => {
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      // Simulate the abort the timeout controller raises.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    }) as typeof fetch;

    const error = await captureRejection(() =>
      sendChatMessage({
        webhookId: 'bba97385-5d58-421b-b1b4-693ff678ac83',
        sessionId: 's',
        chatInput: 'x',
        correlationId: 'cid',
        timeoutMs: 50,
      }),
    );

    // A timeout means the work may still be running, so the user is told
    // something different from "the agent is down" (§38).
    expect((error as { code: string }).code).toBe('agent_timeout');
  });

  it('maps a 5xx to a failure and a 4xx to unavailable', async () => {
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 500 })) as typeof fetch;
    const serverError = await captureRejection(() =>
      sendChatMessage({
        webhookId: 'bba97385-5d58-421b-b1b4-693ff678ac83',
        sessionId: 's',
        chatInput: 'x',
        correlationId: 'cid',
      }),
    );
    expect((serverError as { code: string }).code).toBe('agent_failed');

    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 404 })) as typeof fetch;
    const clientError = await captureRejection(() =>
      sendChatMessage({
        webhookId: 'bba97385-5d58-421b-b1b4-693ff678ac83',
        sessionId: 's',
        chatInput: 'x',
        correlationId: 'cid',
      }),
    );
    expect((clientError as { code: string }).code).toBe('agent_unavailable');
  });

  it('never leaks the upstream body into a user-facing message', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response('Error: connection to postgres://user:pw@db failed', { status: 500 }),
    ) as typeof fetch;

    const error = await captureRejection(() =>
      sendChatMessage({
        webhookId: 'bba97385-5d58-421b-b1b4-693ff678ac83',
        sessionId: 's',
        chatInput: 'x',
        correlationId: 'cid',
      }),
    );

    // The detail lives on internalMessage, which the API layer logs and never
    // serializes into a response body.
    const appError = error as { code: string; internalMessage?: string };
    expect(appError.code).toBe('agent_failed');
    expect(appError.internalMessage).toContain('postgres://');
    // And the error's public identity carries none of it.
    expect(appError.code).not.toContain('postgres');
  });

  it('fails clearly when n8n is not configured at all', async () => {
    delete process.env.N8N_BASE_URL;
    resetEnvCache();

    const error = await captureRejection(() =>
      sendChatMessage({
        webhookId: 'x',
        sessionId: 's',
        chatInput: 'x',
        correlationId: 'cid',
      }),
    );

    // Explicit configuration error, never a fabricated success (§52).
    expect((error as { code: string }).code).toBe('integration_not_configured');
  });

  it('sends an uploaded creative on the first message, as the ads workflow requires', async () => {
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response('{"output":"ok"}', { status: 200 });
    }) as typeof fetch;

    await sendChatMessage({
      webhookId: 'bba97385-5d58-421b-b1b4-693ff678ac83',
      sessionId: 's',
      chatInput: 'campaign details',
      files: [{ name: 'creative.jpg', type: 'image/jpeg', data: 'AAAA' }],
      correlationId: 'cid',
    });

    expect(body?.files).toEqual([
      { name: 'creative.jpg', type: 'image/jpeg', data: 'AAAA' },
    ]);
  });
});
