import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { resolvePathWithin } from '../platform/app-paths';

export class MediaRangeError extends Error {
  constructor(
    message: string,
    readonly status = 416
  ) {
    super(message);
    this.name = 'MediaRangeError';
  }
}

export interface ByteRange {
  start: number;
  end: number;
}

export function parseByteRange(value: string | null, size: number): ByteRange | null {
  if (!value) return null;
  if (!Number.isSafeInteger(size) || size <= 0)
    throw new MediaRangeError('Media range is unavailable for an empty file.');
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) throw new MediaRangeError('Media range is invalid.');
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0)
      throw new MediaRangeError('Media suffix range is invalid.');
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  )
    throw new MediaRangeError('Media range is outside the file.');
  return { start, end: Math.min(requestedEnd, size - 1) };
}

export async function safeLocalMediaPath(mediaRoot: string, candidate: string): Promise<string> {
  const lexical = isAbsolute(candidate) ? candidate : resolvePathWithin(mediaRoot, candidate);
  const [root, file] = await Promise.all([realpath(mediaRoot), realpath(lexical)]);
  resolvePathWithin(root, file);
  return file;
}

export function privateMediaHeaders(contentType: string, size: number): Headers {
  return new Headers({
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600',
    'content-length': String(size),
    'content-type': contentType,
    'cross-origin-resource-policy': 'same-origin',
    'x-content-type-options': 'nosniff'
  });
}

export function assertPrivateMediaRequest(request: Request): void {
  if (request.headers.get('sec-fetch-site') === 'cross-site')
    throw new MediaRangeError('Cross-site local media access is not allowed.', 403);
}

export interface FolderOpenDependencies {
  platform?: NodeJS.Platform;
  spawn?: (command: string[]) => { unref?: () => void };
}

export async function openContainingFolder(
  mediaRoot: string,
  localPath: string,
  dependencies: FolderOpenDependencies = {}
): Promise<void> {
  const file = await safeLocalMediaPath(mediaRoot, localPath);
  const folder = dirname(file);
  const platform = dependencies.platform ?? process.platform;
  const command =
    platform === 'darwin'
      ? ['open', folder]
      : platform === 'win32'
        ? ['explorer', folder]
        : ['xdg-open', folder];
  const processHandle = (dependencies.spawn ?? defaultSpawn)(command);
  processHandle.unref?.();
}

function defaultSpawn(command: string[]): { unref: () => void } {
  const child = Bun.spawn(command, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  return { unref: () => child.unref() };
}
