/**
 * Generates docs/openapi.json.
 *
 * The request schemas are imported from the same modules the routes validate
 * with, and converted to JSON Schema — so the document cannot claim a shape the
 * implementation does not enforce. A hand-written spec drifts within a sprint;
 * this one fails to build if a schema is renamed.
 *
 *   npm run openapi
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { campaignDraftSchema } from '../src/server/api/schemas/campaign';
import { locales } from '../src/i18n/config';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../src/lib/password-policy';
import {
  CREATIVE_ASPECT_RATIOS,
  META_PLACEMENTS,
} from '../src/server/agents/contracts';

/* -------------------------------------------------------------------------- */
/* Minimal Zod -> JSON Schema conversion                                      */
/*                                                                            */
/* Only the constructs these schemas actually use. A general-purpose converter */
/* is a dependency and a maintenance surface; this is 60 lines that fail       */
/* loudly on anything it does not recognise, which is the behaviour worth      */
/* having.                                                                     */
/* -------------------------------------------------------------------------- */

type JsonSchema = Record<string, unknown>;

function toJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const def = schema._def as { typeName: string } & Record<string, unknown>;

  switch (def.typeName) {
    case 'ZodObject': {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];

      for (const [key, value] of Object.entries(shape)) {
        properties[key] = toJsonSchema(value as z.ZodTypeAny);
        if (!(value as z.ZodTypeAny).isOptional()) required.push(key);
      }

      return {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
      };
    }

    case 'ZodString': {
      const checks = (def.checks ?? []) as Array<{ kind: string; value?: number }>;
      const out: JsonSchema = { type: 'string' };
      for (const check of checks) {
        if (check.kind === 'min') out.minLength = check.value;
        if (check.kind === 'max') out.maxLength = check.value;
        if (check.kind === 'email') out.format = 'email';
        if (check.kind === 'url') out.format = 'uri';
        if (check.kind === 'uuid') out.format = 'uuid';
        if (check.kind === 'regex') out.pattern = String((check as { regex?: RegExp }).regex?.source);
      }
      return out;
    }

    case 'ZodNumber': {
      const checks = (def.checks ?? []) as Array<{ kind: string; value?: number }>;
      const out: JsonSchema = { type: 'number' };
      for (const check of checks) {
        if (check.kind === 'min') out.minimum = check.value;
        if (check.kind === 'max') out.maximum = check.value;
        if (check.kind === 'int') out.type = 'integer';
      }
      return out;
    }

    case 'ZodBoolean':
      return { type: 'boolean' };

    case 'ZodLiteral':
      return { const: def.value };

    case 'ZodEnum':
      return { type: 'string', enum: def.values as string[] };

    case 'ZodArray':
      return { type: 'array', items: toJsonSchema(def.type as z.ZodTypeAny) };

    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
      return toJsonSchema(def.innerType as z.ZodTypeAny);

    case 'ZodEffects':
      return toJsonSchema(def.schema as z.ZodTypeAny);

    case 'ZodRecord':
      return { type: 'object', additionalProperties: true };

    case 'ZodUnion':
      return { oneOf: (def.options as z.ZodTypeAny[]).map(toJsonSchema) };

    default:
      throw new Error(
        `openapi: no conversion for ${def.typeName}. Add one rather than emitting a schema that lies.`,
      );
  }
}

/* -------------------------------------------------------------------------- */
/* Schemas mirrored from the route modules                                    */
/*                                                                            */
/* Next.js Route Handlers may only export HTTP methods, so a schema declared   */
/* inside one cannot be imported here. Those are restated below; the shared    */
/* ones are imported directly. The parity is checked by the API tests.         */
/* -------------------------------------------------------------------------- */

const registerSchema = z.object({
  organizationName: z.string().min(2).max(200),
  name: z.string().min(2).max(120),
  email: z.string().email().max(254),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  locale: z.enum(locales),
});

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

const generateAssetSchema = z.object({
  prompt: z.string().min(3).max(2000),
  mediaType: z.enum(['IMAGE', 'VIDEO']),
  aspectRatio: z.enum(CREATIVE_ASPECT_RATIOS),
});

const askQuestionSchema = z.object({
  question: z.string().min(1).max(4000),
});

const confirmSchema = z.object({ confirmed: z.literal(true) });

/* -------------------------------------------------------------------------- */

const ERROR_RESPONSE: JsonSchema = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'Stable identifier that doubles as an i18n key (`errors.<code>`). The client renders it in the reader’s language; the API never returns prose.',
        },
        reference: {
          type: 'string',
          description:
            'Correlation id. Also in the X-Correlation-Id header and on every log line for the request.',
        },
        params: { type: 'object', additionalProperties: true },
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              rule: { type: 'string', description: 'i18n key under `errors.field.*`' },
              params: { type: 'object', additionalProperties: true },
            },
            required: ['path', 'rule'],
          },
        },
      },
      required: ['code', 'reference'],
    },
  },
  required: ['error'],
};

function errorResponse(description: string): JsonSchema {
  return {
    description,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  };
}

function jsonBody(schema: z.ZodTypeAny, required = true): JsonSchema {
  return {
    required,
    content: { 'application/json': { schema: toJsonSchema(schema) } },
  };
}

const COMMON_ERRORS = {
  '401': errorResponse('No valid session.'),
  '403': errorResponse('Cross-origin request, or insufficient permission.'),
  '422': errorResponse('Validation failed; `fields` names each offending path.'),
  '429': errorResponse('Rate limited. `params.seconds` and `Retry-After` give the wait.'),
  '500': errorResponse('Unexpected error. Quote `reference` to support.'),
};

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'AI Workforce API',
    version: '1.0.0',
    description: [
      'Multi-tenant API for a bilingual AI workforce platform.',
      '',
      'Two things to know before integrating:',
      '',
      '1. Errors carry a **code**, never a message. Render `errors.<code>` from your',
      '   own catalogue. This is what lets one backend serve Arabic and English',
      '   users correctly.',
      '2. Every response is tenant-scoped by the session. A resource belonging to',
      '   another organization returns 404, not 403 — which reveals nothing.',
    ].join('\n'),
  },
  servers: [{ url: '/api/v1' }],
  security: [{ sessionCookie: [] }],
  components: {
    securitySchemes: {
      sessionCookie: {
        type: 'apiKey',
        in: 'cookie',
        name: '__Host-aiw_session',
        description:
          'httpOnly, Secure, SameSite=Lax. Set by /auth/login. State-changing requests must also carry a matching Origin.',
      },
    },
    schemas: { Error: ERROR_RESPONSE },
    parameters: {
      IdempotencyKey: {
        name: 'Idempotency-Key',
        in: 'header',
        required: false,
        schema: { type: 'string', minLength: 8, maxLength: 128 },
        description:
          'Replaying a key returns the original result instead of repeating the work.',
      },
    },
  },
  paths: {
    '/auth/register': {
      post: {
        summary: 'Create an organization and its first administrator',
        description:
          'Issues no session: the account stays PENDING_VERIFICATION until the emailed link is opened.',
        security: [],
        requestBody: jsonBody(registerSchema),
        responses: {
          '201': { description: 'Created; a verification email has been sent.' },
          '409': errorResponse('An account already exists for that address.'),
          ...COMMON_ERRORS,
        },
      },
    },
    '/auth/login': {
      post: {
        summary: 'Sign in',
        description:
          'A wrong password and an unknown address return the identical code after comparable work.',
        security: [],
        requestBody: jsonBody(loginSchema),
        responses: {
          '200': { description: 'Session cookie set.' },
          '423': errorResponse('Locked after repeated failures; `params.minutes` gives the wait.'),
          ...COMMON_ERRORS,
        },
      },
    },
    '/auth/logout': {
      post: { summary: 'Revoke the current session', responses: { '200': { description: 'OK' }, ...COMMON_ERRORS } },
    },
    '/auth/verify-email': {
      post: {
        summary: 'Redeem a verification token',
        description:
          'POST rather than a GET on the link: mail scanners fetch URLs eagerly and would burn a single-use token.',
        security: [],
        requestBody: jsonBody(z.object({ token: z.string().min(16).max(256) })),
        responses: { '200': { description: 'Verified.' }, '410': errorResponse('Expired.'), ...COMMON_ERRORS },
      },
    },
    '/auth/request-password-reset': {
      post: {
        summary: 'Request a reset link',
        description:
          'Always 200 with the same body, whether or not the address exists — otherwise this is an enumeration oracle.',
        security: [],
        requestBody: jsonBody(z.object({ email: z.string().email(), locale: z.enum(locales) })),
        responses: { '200': { description: 'Accepted.' }, ...COMMON_ERRORS },
      },
    },
    '/auth/reset-password': {
      post: {
        summary: 'Set a new password',
        description: 'Revokes every session on success.',
        security: [],
        requestBody: jsonBody(
          z.object({
            token: z.string().min(16).max(256),
            newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
          }),
        ),
        responses: { '200': { description: 'Updated.' }, ...COMMON_ERRORS },
      },
    },
    '/me/locale': {
      patch: {
        summary: 'Persist the language preference',
        requestBody: jsonBody(z.object({ locale: z.enum(locales) })),
        responses: { '200': { description: 'Saved.' }, ...COMMON_ERRORS },
      },
    },
    '/me/password': {
      patch: {
        summary: 'Change password',
        description: 'Requires the current password. Revokes every session, including this one.',
        requestBody: jsonBody(
          z.object({
            currentPassword: z.string().min(1),
            newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
          }),
        ),
        responses: { '200': { description: 'Changed.' }, ...COMMON_ERRORS },
      },
    },
    '/agents': {
      get: {
        summary: 'Agent catalogue and capabilities',
        description:
          'Includes `unavailable[]` with a localizable `reasonKey` per gap. Render "not available" states from this rather than hard-coded copy, so claims cannot drift from what the workflows do.',
        responses: { '200': { description: 'OK' }, ...COMMON_ERRORS },
      },
    },
    '/knowledge/conversations': {
      get: { summary: 'List conversations', responses: { '200': { description: 'OK' }, ...COMMON_ERRORS } },
      post: {
        summary: 'Start a conversation',
        requestBody: jsonBody(z.object({ title: z.string().max(200), locale: z.enum(locales) }), false),
        responses: { '201': { description: 'Created' }, ...COMMON_ERRORS },
      },
    },
    '/knowledge/conversations/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      get: { summary: 'Conversation and messages', responses: { '200': { description: 'OK' }, '404': errorResponse('Not found, or belongs to another tenant.'), ...COMMON_ERRORS } },
      delete: { summary: 'Delete a conversation', responses: { '200': { description: 'Deleted' }, ...COMMON_ERRORS } },
    },
    '/knowledge/conversations/{id}/messages': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      post: {
        summary: 'Ask a question',
        description:
          'Returns 200 with an `error` object when the agent fails: the question was already saved and the UI must render it with a retry. A 5xx would discard what the user typed.',
        requestBody: jsonBody(askQuestionSchema),
        responses: { '201': { description: 'Answered' }, '200': { description: 'Saved, but the agent failed.' }, ...COMMON_ERRORS },
      },
    },
    '/knowledge/messages/{id}/feedback': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      patch: {
        summary: 'Rate an answer',
        requestBody: jsonBody(z.object({ feedback: z.union([z.literal(1), z.literal(-1)]) })),
        responses: { '200': { description: 'Recorded' }, ...COMMON_ERRORS },
      },
    },
    '/assets': {
      get: { summary: 'List assets', responses: { '200': { description: 'OK' }, ...COMMON_ERRORS } },
      post: {
        summary: 'Generate an asset',
        description:
          'The connected Creative workflow cannot generate video; a VIDEO request returns an image with `downgradedToImage: true`.',
        parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
        requestBody: jsonBody(generateAssetSchema),
        responses: { '201': { description: 'Generated' }, '503': errorResponse('Storage or the agent is not configured.'), ...COMMON_ERRORS },
      },
    },
    '/assets/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      get: { summary: 'Asset detail with a presigned URL', responses: { '200': { description: 'OK' }, ...COMMON_ERRORS } },
      delete: { summary: 'Delete an asset', responses: { '200': { description: 'Deleted' }, '409': errorResponse('Attached to an unsubmitted campaign.'), ...COMMON_ERRORS } },
    },
    '/assets/{id}/content': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      get: { summary: 'Redirect to the bytes', description: '302 to a short-lived presigned URL, minted only after the tenant check.', responses: { '302': { description: 'Redirect' }, ...COMMON_ERRORS } },
    },
    '/campaigns': {
      get: { summary: 'List campaigns', responses: { '200': { description: 'OK' }, ...COMMON_ERRORS } },
      post: { summary: 'Create a draft', requestBody: jsonBody(campaignDraftSchema), responses: { '201': { description: 'Created' }, ...COMMON_ERRORS } },
    },
    '/campaigns/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      get: { summary: 'Campaign, review warnings and performance', responses: { '200': { description: 'OK' }, ...COMMON_ERRORS } },
      patch: { summary: 'Update a draft', description: 'Any edit clears a previous approval.', requestBody: jsonBody(campaignDraftSchema.partial()), responses: { '200': { description: 'Updated' }, ...COMMON_ERRORS } },
      delete: { summary: 'Delete a campaign', description: 'Removes it from the workspace only; Meta objects already created are not deleted.', responses: { '200': { description: 'Deleted' }, ...COMMON_ERRORS } },
    },
    '/campaigns/{id}/approve': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      post: {
        summary: 'Record explicit approval',
        description: 'Freezes an immutable snapshot of exactly what the approver saw.',
        requestBody: jsonBody(confirmSchema),
        responses: { '200': { description: 'Approved; status READY.' }, '409': errorResponse('Not approvable from its current status.'), ...COMMON_ERRORS },
      },
    },
    '/campaigns/{id}/launch': {
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 128 } },
      ],
      post: {
        summary: 'Submit an approved campaign to Meta',
        description: [
          'Creates a campaign, ad set and ad on the connected ad account.',
          '',
          'On success the campaign becomes **PAUSED**, never ACTIVE: the workflow',
          'creates every Meta object paused and has no activation step. Nothing',
          'spends until someone activates it in Ads Manager.',
          '',
          'Idempotency-Key is required. Without one a retry could create a second',
          'campaign and a second budget.',
        ].join('\n'),
        requestBody: jsonBody(confirmSchema),
        responses: {
          '201': { description: 'Created on Meta, paused.' },
          '200': { description: 'The agent rejected the submission; see `error`.' },
          '409': errorResponse('Already launched, or not in READY.'),
          ...COMMON_ERRORS,
        },
      },
    },
    '/analytics': {
      get: {
        summary: 'Usage and performance',
        description:
          '`unavailableMetrics[]` names the metrics the connected integrations cannot supply. Render that rather than charting zeros.',
        responses: { '200': { description: 'OK' }, ...COMMON_ERRORS },
      },
    },
    '/activity': { get: { summary: 'Audit trail', description: 'Read-only. Actions are stable i18n keys, not prose.', responses: { '200': { description: 'OK' }, ...COMMON_ERRORS } } },
    '/jobs': { get: { summary: 'Agent jobs', responses: { '200': { description: 'OK' }, ...COMMON_ERRORS } } },
    '/integrations': { get: { summary: 'Integration status', description: 'Status and identifiers only. Never the n8n base URL, webhook ids or any credential.', responses: { '200': { description: 'OK' }, ...COMMON_ERRORS } } },
    '/health': { get: { summary: 'Liveness and readiness', security: [], responses: { '200': { description: 'Healthy' }, '503': { description: 'Database unreachable.' } } } },
    '/webhooks/n8n': {
      post: {
        summary: 'Inbound n8n callback',
        description: [
          'HMAC-SHA256 over `${timestamp}.${nonce}.${rawBody}`, sent as',
          '`X-AIW-Signature: t=…,n=…,v1=…`. Timestamp window ±5 minutes; nonces are',
          'recorded with a unique index, so a replay fails on the second attempt.',
          '',
          'Receives no traffic today: none of the three workflows calls back. It is',
          'implemented and tested so adopting the pattern is a workflow change.',
        ].join('\n'),
        security: [],
        responses: { '200': { description: 'Applied, or a recognised duplicate.' }, '401': errorResponse('Signature missing, malformed, stale or forged.'), '404': errorResponse('Signature valid but the request is unknown.') },
      },
    },
  },
};

const target = path.resolve(__dirname, '../docs/openapi.json');
mkdirSync(path.dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');

const pathCount = Object.keys(spec.paths).length;
const operationCount = Object.values(spec.paths).reduce(
  (total, item) =>
    total + Object.keys(item).filter((k) => ['get', 'post', 'patch', 'delete', 'put'].includes(k)).length,
  0,
);

console.log(`docs/openapi.json — ${pathCount} paths, ${operationCount} operations`);
