import { constants, type Dirent } from 'node:fs';
import { link, open, readdir, rm, unlink } from 'node:fs/promises';
import { basename } from 'node:path';
import type {
  MediaPrivacySettings,
  MediaSanitizationReceiptDto,
  MediaToolReadinessDto,
  MediaToolsReadinessDto
} from '../../features/settings/contracts';
import {
  DEFAULT_MEDIA_PRIVACY_SETTINGS,
  mediaKindSanitizationReady
} from '../../features/settings/media-privacy';
import type { AppPaths } from '../platform/app-paths';
import { resolvePathWithin } from '../platform/app-paths';
import { RequestSecurityError } from '../platform/request-security';
import { POYO_STREAM_VIDEO_MAX_BYTES, validateLocalFile } from '../poyo/uploads';
import {
  assertCanonicalDirectory,
  ensureCanonicalChildDirectory,
  ensureCanonicalRoot,
  readExactPositioned,
  syncDirectory
} from './filesystem-boundary';
import {
  MediaPrerequisiteError,
  type MediaSanitizer,
  probeMediaTools,
  sanitizeMedia
} from './media-sanitizer';

const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const REQUEST_MAX_BYTES = 101 * 1024 * 1024;

export interface SourceIntakeOptions {
  maxRequestBytes?: number;
  mediaPrivacy?: MediaPrivacySettings;
  readiness?: () => Promise<MediaToolsReadinessDto>;
  sanitizer?: MediaSanitizer;
}

export class SourceIntakeError extends Error {
  readonly code = 'source_sanitization_failed';
  readonly status = 422;

  constructor(cause?: unknown) {
    super('The local file could not be sanitized safely.', { cause });
    this.name = 'SourceIntakeError';
  }
}

export class SourceIntakePrerequisiteError extends Error {
  readonly code = 'source_media_prerequisite_failed' as const;
  readonly status = 422;

  constructor(
    readonly tool: MediaToolReadinessDto,
    cause?: unknown
  ) {
    super(
      cause instanceof MediaPrerequisiteError
        ? cause.message
        : 'Optional media cleanup became unavailable after it started.',
      {
        cause
      }
    );
    this.name = 'SourceIntakePrerequisiteError';
  }
}

const extensions: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-msvideo': '.avi',
  'video/x-matroska': '.mkv'
};

const sourceId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sourceTemporary =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:raw|sanitized|oriented)\.(?:jpg|png|gif|webp|mp4|webm|mov|avi|mkv)$/i;

export function localSourceExtension(mimeType: string): string {
  const extension = extensions[mimeType.toLowerCase()];
  if (!extension) throw new Error('The selected local file format is not supported.');
  return extension;
}

export function neutralSourceUploadName(id: string, mimeType: string): string {
  if (!sourceId.test(id)) throw new Error('The managed local source identifier is not valid.');
  return `${id}${localSourceExtension(mimeType)}`;
}

interface SourceIntakeRecoveryOperations {
  readDirectory: (path: string) => Promise<Dirent[]>;
  unlink: (path: string) => Promise<void>;
  syncDirectory: (path: string) => Promise<void>;
}

const sourceIntakeRecoveryOperations: SourceIntakeRecoveryOperations = {
  readDirectory: (path) => readdir(path, { withFileTypes: true }),
  unlink,
  syncDirectory
};

export async function recoverSourceIntakeTemporaries(
  paths: Pick<AppPaths, 'temporary'>,
  operations: SourceIntakeRecoveryOperations = sourceIntakeRecoveryOperations
): Promise<number> {
  const root = await ensureCanonicalRoot(paths.temporary, 'Managed source temporary recovery');
  const entries = await operations.readDirectory(root);
  let removed = 0;
  for (const entry of entries) {
    if (!sourceTemporary.test(entry.name) || (!entry.isFile() && !entry.isSymbolicLink())) continue;
    await assertCanonicalDirectory(root, root, 'Managed source temporary recovery');
    const target = resolvePathWithin(root, entry.name);
    try {
      await operations.unlink(target);
      removed += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (removed > 0) await operations.syncDirectory(root);
  return removed;
}

export interface LocalSourceIntake {
  id: string;
  originalName: string;
  mediaKind: 'image' | 'video';
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  signature: string;
  createdAt: string;
  localPath: string;
  sanitization: MediaSanitizationReceiptDto;
}

function assertSameOriginMultipart(request: Request, maxBytes: number): string {
  const expectedOrigin = new URL(request.url).origin;
  const origin = request.headers.get('origin');
  if (!origin)
    throw new RequestSecurityError('origin_required', 403, 'An Origin header is required.');
  if (origin !== expectedOrigin)
    throw new RequestSecurityError('origin_mismatch', 403, 'Request origin does not match.');
  if (request.headers.get('sec-fetch-site') === 'cross-site')
    throw new RequestSecurityError('cross_site', 403, 'Cross-site requests are not allowed.');
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data(?:\s*;|$)/i.test(contentType))
    throw new RequestSecurityError(
      'invalid_content_type',
      415,
      'Source intake requires multipart/form-data.'
    );
  const boundaryMatch = /(?:^|;)\s*boundary=(?:"([^"\r\n]{1,70})"|([^;\s\r\n]{1,70}))/i.exec(
    contentType
  );
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (
    !boundary ||
    Array.from(boundary).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 32 || code === 127;
    })
  ) {
    throw new RequestSecurityError('invalid_multipart', 400, 'Multipart boundary is invalid.');
  }
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RequestSecurityError('invalid_content_length', 400, 'Invalid Content-Length.');
    }
    if (length > maxBytes)
      throw new RequestSecurityError('body_too_large', 413, 'Source upload is too large.');
  }
  return boundary;
}

async function boundedFormData(
  request: Request,
  maxBytes: number,
  boundary: string
): Promise<FormData> {
  if (!request.body) throw new Error('Source upload body is missing.');
  let received = 0;
  let lastBoundaryOffset = -1;
  let partCount = 0;
  let tail = '';
  const marker = `--${boundary}`;
  const decoder = new TextDecoder('latin1');
  const reader = request.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        received += value.byteLength;
        if (received > maxBytes) {
          await reader.cancel('request body too large');
          controller.error(
            new RequestSecurityError('body_too_large', 413, 'Source upload is too large.')
          );
          return;
        }
        const startOffset = received - value.byteLength - tail.length;
        const sample = tail + decoder.decode(value);
        let markerOffset = sample.indexOf(marker);
        while (markerOffset !== -1) {
          const absoluteOffset = startOffset + markerOffset;
          const precededByLine =
            absoluteOffset === 0 || sample.slice(markerOffset - 2, markerOffset) === '\r\n';
          const suffix = sample.slice(
            markerOffset + marker.length,
            markerOffset + marker.length + 2
          );
          if (absoluteOffset > lastBoundaryOffset && precededByLine && suffix === '\r\n') {
            lastBoundaryOffset = absoluteOffset;
            partCount += 1;
            if (partCount > 2) {
              await reader.cancel('too many multipart parts');
              controller.error(
                new RequestSecurityError(
                  'invalid_multipart',
                  400,
                  'Source upload requires exactly one file and one media kind.'
                )
              );
              return;
            }
          }
          markerOffset = sample.indexOf(marker, markerOffset + marker.length);
        }
        tail = sample.slice(-(marker.length + 4));
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    }
  });
  return new Response(body, {
    headers: { 'content-type': request.headers.get('content-type') ?? '' }
  }).formData();
}

function requiredParts(form: FormData): { file: File; mediaKind: 'image' | 'video' } {
  const entries = [...form.entries()];
  const files = form.getAll('file');
  const mediaKinds = form.getAll('mediaKind');
  if (
    entries.length !== 2 ||
    files.length !== 1 ||
    mediaKinds.length !== 1 ||
    entries.some(([name]) => name !== 'file' && name !== 'mediaKind') ||
    !(files[0] instanceof File) ||
    (mediaKinds[0] !== 'image' && mediaKinds[0] !== 'video')
  ) {
    throw new RequestSecurityError(
      'invalid_multipart',
      400,
      'Source upload requires exactly one file and one media kind.'
    );
  }
  return { file: files[0], mediaKind: mediaKinds[0] };
}

function hasSignature(type: string, bytes: Uint8Array): boolean {
  const ascii = (start: number, end: number) => new TextDecoder().decode(bytes.slice(start, end));
  if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'image/png')
    return (
      bytes[0] === 0x89 &&
      ascii(1, 4) === 'PNG' &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  if (type === 'image/gif') return ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a';
  if (type === 'image/webp') return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
  if (type === 'video/mp4')
    return (
      ascii(4, 8) === 'ftyp' &&
      [
        'isom',
        'iso2',
        'iso3',
        'iso4',
        'iso5',
        'iso6',
        'mp41',
        'mp42',
        'avc1',
        'dash',
        'M4V '
      ].includes(ascii(8, 12))
    );
  if (type === 'video/quicktime') return ascii(4, 8) === 'ftyp' && ascii(8, 12) === 'qt  ';
  if (type === 'video/x-msvideo') return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'AVI ';
  if (type === 'video/webm' || type === 'video/x-matroska')
    return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  return false;
}

function safeOriginalName(value: string): string {
  const name = Array.from(basename(value))
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join('')
    .trim();
  return name && name !== '.' && name !== '..' ? name.slice(0, 255) : 'source';
}

async function writeStreamed(file: File, destination: string): Promise<void> {
  const handle = await open(
    destination,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600
  );
  const reader = file.stream().getReader();
  let written = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      written += value.byteLength;
      let offset = 0;
      while (offset < value.byteLength) {
        const result = await handle.write(value, offset, value.byteLength - offset);
        if (result.bytesWritten <= 0) throw new Error('The local source copy is incomplete.');
        offset += result.bytesWritten;
      }
    }
    if (written !== file.size) throw new Error('The local source copy is incomplete.');
    await handle.sync();
  } finally {
    await reader.cancel().catch(() => undefined);
    await handle.close();
  }
}

async function makePrivateRegular(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const details = await handle.stat();
    if (!details.isFile()) throw new Error('The sanitized local source is not a regular file.');
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

interface CandidateDetails {
  sizeBytes: number;
  checksum: string;
  signature: string;
}

async function inspectCandidate(
  path: string,
  mimeType: string,
  maxBytes: number
): Promise<CandidateDetails> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size <= 0 || details.size > maxBytes) {
      throw new Error('The sanitized local source size is invalid.');
    }
    const header = new Uint8Array(Math.min(16, details.size));
    await readExactPositioned(handle, header, 0);
    if (!hasSignature(mimeType, header)) {
      throw new Error('The sanitized local source signature does not match its type.');
    }

    const hasher = new Bun.CryptoHasher('sha256');
    const buffer = new Uint8Array(64 * 1024);
    let position = 0;
    while (position < details.size) {
      const length = Math.min(buffer.byteLength, details.size - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead <= 0) throw new Error('The sanitized local source is incomplete.');
      hasher.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return {
      sizeBytes: details.size,
      checksum: hasher.digest('hex'),
      signature: Array.from(header, (byte) => byte.toString(16).padStart(2, '0')).join('')
    };
  } finally {
    await handle.close();
  }
}

export async function intakeLocalSource(
  request: Request,
  paths: AppPaths,
  options: SourceIntakeOptions = {}
): Promise<LocalSourceIntake> {
  const maxRequestBytes = options.maxRequestBytes ?? REQUEST_MAX_BYTES;
  const mediaPrivacy = options.mediaPrivacy ?? DEFAULT_MEDIA_PRIVACY_SETTINGS;
  const readiness = options.readiness ?? probeMediaTools;
  const sanitizer = options.sanitizer ?? sanitizeMedia;
  const boundary = assertSameOriginMultipart(request, maxRequestBytes);
  const { file, mediaKind: requestedKind } = requiredParts(
    await boundedFormData(request, maxRequestBytes, boundary)
  );
  if (requestedKind === 'image' && file.size > IMAGE_MAX_BYTES)
    throw new Error('Local image sources are limited to 25 MB.');
  const type = file.type.toLowerCase();
  const extension = localSourceExtension(type);
  validateLocalFile({
    kind: 'local-file',
    file,
    mimeType: type,
    sizeBytes: file.size,
    mediaKind: requestedKind,
    fileName: safeOriginalName(file.name)
  });
  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (!hasSignature(type, header))
    throw new Error('The local source signature does not match its type.');

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const bucket = createdAt.slice(0, 7);
  const uploadRoot = await ensureCanonicalRoot(paths.uploads, 'Managed source upload');
  const temporaryRoot = await ensureCanonicalRoot(paths.temporary, 'Managed source temporary');
  const directory = await ensureCanonicalChildDirectory(
    uploadRoot,
    bucket,
    'Managed source upload'
  );
  const destination = resolvePathWithin(directory.path, `${id}${extension}`);
  const rawTemporary = resolvePathWithin(temporaryRoot, `${id}.raw${extension}`);
  const sanitizedTemporary = resolvePathWithin(temporaryRoot, `${id}.sanitized${extension}`);
  let published = false;
  let sanitizationPendingVerification = false;
  try {
    await writeStreamed(file, rawTemporary);
    await assertCanonicalDirectory(temporaryRoot, temporaryRoot, 'Managed source temporary');
    let candidate = rawTemporary;
    let sanitization: MediaSanitizationReceiptDto = {
      applied: false,
      notAppliedReason: 'preference-disabled',
      mediaKind: requestedKind,
      removedCategories: [],
      preservedCategories: [],
      orientationNormalized: null
    };
    const maxOutputBytes =
      requestedKind === 'image' ? IMAGE_MAX_BYTES : POYO_STREAM_VIDEO_MAX_BYTES;
    if (mediaPrivacy.sanitizeLocalMedia) {
      const currentReadiness = await readiness().catch(() => null);
      if (!currentReadiness || !mediaKindSanitizationReady(currentReadiness, requestedKind)) {
        sanitization = { ...sanitization, notAppliedReason: 'tools-unavailable' };
      } else {
        sanitizationPendingVerification = true;
        sanitization = await sanitizer({
          inputPath: rawTemporary,
          outputPath: sanitizedTemporary,
          mimeType: type,
          mediaKind: requestedKind,
          settings: mediaPrivacy,
          maxOutputBytes
        });
        await makePrivateRegular(sanitizedTemporary);
        candidate = sanitizedTemporary;
      }
    }
    await assertCanonicalDirectory(temporaryRoot, temporaryRoot, 'Managed source temporary');
    const details = await inspectCandidate(candidate, type, maxOutputBytes);
    sanitizationPendingVerification = false;
    await assertCanonicalDirectory(uploadRoot, directory.path, 'Managed source upload');
    await assertCanonicalDirectory(temporaryRoot, temporaryRoot, 'Managed source temporary');
    await link(candidate, destination);
    published = true;
    await syncDirectory(directory.path);
    await rm(rawTemporary, { force: true });
    await rm(sanitizedTemporary, { force: true });
    return {
      id,
      originalName: safeOriginalName(file.name),
      mediaKind: requestedKind,
      mimeType: type,
      sizeBytes: details.sizeBytes,
      checksum: details.checksum,
      signature: details.signature,
      createdAt,
      localPath: destination,
      sanitization
    };
  } catch (error) {
    await rm(rawTemporary, { force: true }).catch(() => undefined);
    await rm(sanitizedTemporary, { force: true }).catch(() => undefined);
    if (published) {
      await rm(destination, { force: true }).catch(() => undefined);
      await syncDirectory(directory.path).catch(() => undefined);
    }
    if (error instanceof MediaPrerequisiteError) {
      throw new SourceIntakePrerequisiteError(error.tool, error);
    }
    if (
      sanitizationPendingVerification &&
      !(error instanceof SourceIntakeError) &&
      !(error instanceof SourceIntakePrerequisiteError)
    ) {
      throw new SourceIntakeError(error);
    }
    throw error;
  }
}
