import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';
import { env, isStorageConfigured } from '@/server/config/env';
import { AppError } from '@/lib/errors';
import { logger } from '@/server/observability/logger';

/**
 * S3-compatible object storage (§19).
 *
 * Media never goes in Postgres. Objects are private; the browser reaches them
 * through short-lived presigned URLs, so a leaked URL expires rather than
 * granting permanent access, and no bucket needs to be public.
 *
 * Keys are `tenants/{organizationId}/{kind}/{assetId}.{ext}`. The tenant prefix
 * is what lets a bucket policy or lifecycle rule operate per tenant, and it
 * makes a mis-scoped key visible on inspection.
 */

let client: S3Client | undefined;

function s3(): S3Client {
  if (!isStorageConfigured()) {
    throw new AppError('storage_not_configured', {
      internalMessage: 'S3_BUCKET / credentials are not set',
    });
  }

  client ??= new S3Client({
    region: env().S3_REGION,
    endpoint: env().S3_ENDPOINT || undefined,
    forcePathStyle: env().S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: env().S3_ACCESS_KEY_ID!,
      secretAccessKey: env().S3_SECRET_ACCESS_KEY!,
    },
  });

  return client;
}

function bucket(): string {
  const name = env().S3_BUCKET;
  if (!name) {
    throw new AppError('storage_not_configured', { internalMessage: 'S3_BUCKET is unset' });
  }
  return name;
}

/* -------------------------------------------------------------------------- */
/* File validation (§33)                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Magic-number signatures.
 *
 * A declared Content-Type and a file extension are both attacker-controlled.
 * The first bytes are not, so every stored object is identified by its actual
 * content and rejected when the claim and the bytes disagree.
 */
const SIGNATURES: Array<{
  mimeType: string;
  extension: string;
  test: (buffer: Buffer) => boolean;
}> = [
  {
    mimeType: 'image/jpeg',
    extension: 'jpg',
    test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mimeType: 'image/png',
    extension: 'png',
    test: (b) =>
      b.length > 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  {
    mimeType: 'image/webp',
    extension: 'webp',
    test: (b) =>
      b.length > 12 &&
      b.toString('ascii', 0, 4) === 'RIFF' &&
      b.toString('ascii', 8, 12) === 'WEBP',
  },
  {
    mimeType: 'image/gif',
    extension: 'gif',
    test: (b) => b.length > 6 && b.toString('ascii', 0, 6).startsWith('GIF8'),
  },
  {
    mimeType: 'video/mp4',
    extension: 'mp4',
    // ISO-BMFF: 4-byte size, then 'ftyp'.
    test: (b) => b.length > 12 && b.toString('ascii', 4, 8) === 'ftyp',
  },
  {
    mimeType: 'video/quicktime',
    extension: 'mov',
    test: (b) =>
      b.length > 12 &&
      b.toString('ascii', 4, 8) === 'ftyp' &&
      b.toString('ascii', 8, 12).startsWith('qt'),
  },
];

/** Everything the product will ever store. Anything else is refused. */
export const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/quicktime',
]);

export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 512 * 1024 * 1024;

export interface ValidatedFile {
  buffer: Buffer;
  /** MIME type determined from the bytes, not from the caller's claim. */
  mimeType: string;
  extension: string;
  sizeBytes: number;
  /** SHA-256 of the content, used for per-tenant deduplication. */
  checksum: string;
}

/**
 * Validates a file before it is stored.
 *
 * Checks, in order: size, real type from magic bytes, allow-list membership,
 * and agreement between the declared type and the detected one.
 */
export function validateFile(
  buffer: Buffer,
  declaredMimeType?: string,
): ValidatedFile {
  if (buffer.length === 0) {
    throw new AppError('validation_failed', {
      fields: [{ path: 'file', rule: 'required' }],
      internalMessage: 'Empty file',
    });
  }

  const detected = SIGNATURES.find((signature) => signature.test(buffer));

  if (!detected) {
    throw new AppError('unsupported_media_type', {
      internalMessage: `Unrecognised file signature: ${buffer.subarray(0, 12).toString('hex')}`,
    });
  }

  if (!ALLOWED_MIME_TYPES.has(detected.mimeType)) {
    throw new AppError('unsupported_media_type', {
      internalMessage: `${detected.mimeType} is not permitted`,
    });
  }

  const isVideo = detected.mimeType.startsWith('video/');
  const limit = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (buffer.length > limit) {
    throw new AppError('payload_too_large', {
      params: { max: `${Math.floor(limit / 1024 / 1024)} MB` },
      internalMessage: `File is ${buffer.length} bytes, limit ${limit}`,
    });
  }

  // A mismatch between claim and content is the signature of an upload trying
  // to be served back as something it is not.
  if (declaredMimeType) {
    const normalized = declaredMimeType.split(';')[0]?.trim().toLowerCase();
    const compatible =
      normalized === detected.mimeType ||
      // mp4 and quicktime share the ftyp container; treat them as equivalent.
      (normalized === 'video/mp4' && detected.mimeType === 'video/quicktime') ||
      (normalized === 'video/quicktime' && detected.mimeType === 'video/mp4') ||
      (normalized === 'image/jpg' && detected.mimeType === 'image/jpeg');

    if (!compatible) {
      throw new AppError('unsupported_media_type', {
        internalMessage: `Declared ${normalized} but content is ${detected.mimeType}`,
      });
    }
  }

  return {
    buffer,
    mimeType: detected.mimeType,
    extension: detected.extension,
    sizeBytes: buffer.length,
    checksum: createHash('sha256').update(buffer).digest('hex'),
  };
}

/**
 * Builds a storage key.
 *
 * Every component is generated or validated, never taken from user input, which
 * is what forecloses path traversal: there is no way for `../` to enter a key.
 */
export function buildStorageKey(params: {
  organizationId: string;
  kind: 'IMAGE' | 'VIDEO';
  assetId: string;
  extension: string;
}): string {
  const safeExtension = params.extension.replace(/[^a-z0-9]/gi, '').slice(0, 8);
  if (!/^[0-9a-f-]{36}$/i.test(params.organizationId) || !/^[0-9a-f-]{36}$/i.test(params.assetId)) {
    throw new AppError('internal_error', {
      internalMessage: 'Refusing to build a storage key from a non-UUID identifier',
    });
  }
  return `tenants/${params.organizationId}/${params.kind.toLowerCase()}/${params.assetId}.${safeExtension}`;
}

export async function putObject(params: {
  key: string;
  body: Buffer;
  contentType: string;
  metadata?: Record<string, string>;
}): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType,
      // Force download rather than inline rendering. An SVG or HTML served
      // inline from our origin would be a stored-XSS vector; this makes the
      // browser treat every object as a file.
      ContentDisposition: 'attachment',
      // Belt and braces: even if something is rendered, don't let the browser
      // sniff a different type than we declared.
      Metadata: { 'x-content-type-options': 'nosniff', ...params.metadata },
      ServerSideEncryption: 'AES256',
    }),
  );
}

/**
 * Presigned GET URL.
 *
 * Short-lived by default (15 minutes). Generated per request rather than stored,
 * so revoking access is a matter of not issuing another one.
 */
export async function signedDownloadUrl(
  key: string,
  options: { expiresIn?: number; downloadFileName?: string } = {},
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: bucket(),
    Key: key,
    ...(options.downloadFileName
      ? {
          ResponseContentDisposition: `attachment; filename="${sanitizeFileName(
            options.downloadFileName,
          )}"`,
        }
      : {}),
  });

  return getSignedUrl(s3(), command, {
    expiresIn: options.expiresIn ?? env().S3_SIGNED_URL_TTL_SECONDS,
  });
}

/** Strips anything that could break out of the Content-Disposition header. */
function sanitizeFileName(name: string): string {
  return name
    .replace(/[\r\n"\\]/g, '')
    .replace(/[/\\]/g, '_')
    .slice(0, 120);
}

export async function deleteObject(key: string): Promise<void> {
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
  } catch (error) {
    // A missing object is the desired end state; don't fail a user's delete.
    logger.warn(
      { key, err: error instanceof Error ? error.message : String(error) },
      'object delete failed',
    );
  }
}

export async function objectExists(key: string): Promise<boolean> {
  try {
    await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return true;
  } catch {
    return false;
  }
}

/** Health probe for the platform panel. */
export async function probeStorage(): Promise<{
  configured: boolean;
  reachable: boolean;
  latencyMs: number;
  error?: string;
}> {
  if (!isStorageConfigured()) {
    return { configured: false, reachable: false, latencyMs: 0 };
  }

  const startedAt = Date.now();
  try {
    // HEAD on a key that will not exist: a 404 still proves the endpoint and
    // credentials work, which is what we are checking.
    await s3().send(
      new HeadObjectCommand({ Bucket: bucket(), Key: '__healthcheck__' }),
    );
    return { configured: true, reachable: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    const name = error instanceof Error ? error.name : String(error);
    const reachable = name === 'NotFound' || name === 'NoSuchKey';
    return {
      configured: true,
      reachable,
      latencyMs: Date.now() - startedAt,
      error: reachable ? undefined : name,
    };
  }
}
