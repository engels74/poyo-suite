import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { safeErrorSummary } from '../diagnostics/redaction';
import { type AppPaths, resolvePathWithin } from '../platform/app-paths';
import {
  type DownloadHostResolver,
  requestPinnedDownload,
  resolveDownloadTarget
} from './download-egress';
import type { JobRepository } from './repository';
import type { OutputRecord } from './types';

const extensions: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov'
};
const mediaKinds: Record<string, OutputRecord['mediaKind']> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'video/mp4': 'video',
  'video/webm': 'video',
  'video/quicktime': 'video'
};
const genericTypes = new Set(['application/octet-stream', 'binary/octet-stream']);

function safeName(output: OutputRecord, contentType: string): string {
  const remote = output.remoteUrl ? basename(new URL(output.remoteUrl).pathname) : '';
  const clean = basename(remote, extname(remote))
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 80);
  const name = `${clean || `output-${output.outputOrder}`}${extensions[contentType]}`;
  return `${output.outputOrder}-${output.id.slice(0, 8)}-${name}`;
}
function signature(bytes: Uint8Array): string {
  return Array.from(bytes.slice(0, 16))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
function detectedContentType(bytes: Uint8Array): string | null {
  const hex = signature(bytes);
  const ascii = new TextDecoder().decode(bytes.slice(0, 12));
  if (hex.startsWith('89504e470d0a1a0a')) return 'image/png';
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return 'image/gif';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp';
  if (ascii.slice(4, 8) === 'ftyp') {
    const brand = ascii.slice(8, 12);
    if (brand === 'qt  ') return 'video/quicktime';
    if (
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
      ].includes(brand)
    )
      return 'video/mp4';
  }
  if (hex.startsWith('1a45dfa3')) return 'video/webm';
  return null;
}

function normalizedType(value: string | null): string | null {
  const type = value?.split(';', 1)[0]?.trim().toLowerCase();
  return type || null;
}

function verifiedContentType(
  output: OutputRecord,
  responseType: string | null,
  bytes: Uint8Array
): string {
  const metadataType = normalizedType(output.contentType);
  const headerType = normalizedType(responseType);
  for (const type of [metadataType, headerType]) {
    if (type && !genericTypes.has(type) && !mediaKinds[type]) {
      throw new Error('Remote output Content-Type is not supported media.');
    }
  }
  const detected = detectedContentType(bytes);
  if (!detected) throw new Error('Remote output did not contain a supported media signature.');
  if (mediaKinds[detected] !== output.mediaKind) {
    throw new Error('Remote output signature did not match the expected media kind.');
  }
  if (metadataType && !genericTypes.has(metadataType) && metadataType !== detected) {
    throw new Error('Remote output signature did not match Poyo media metadata.');
  }
  if (headerType && !genericTypes.has(headerType) && headerType !== detected) {
    throw new Error('Remote output signature did not match its Content-Type.');
  }
  return detected;
}

async function safeOutputDirectory(
  mediaRoot: string,
  jobId: string
): Promise<{
  root: string;
  directory: string;
}> {
  await mkdir(mediaRoot, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(mediaRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('Media root may not be a symbolic link.');
  }
  const root = await realpath(mediaRoot);
  const directory = resolvePathWithin(root, jobId);
  const existing = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!existing) await mkdir(directory, { mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Output directory may not be a symbolic link.');
  }
  resolvePathWithin(root, await realpath(directory));
  return { root, directory };
}

async function assertSafeDirectory(root: string, directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Output directory may not be a symbolic link.');
  }
  resolvePathWithin(root, await realpath(directory));
}

export interface OutputDownloaderOptions {
  repository: JobRepository;
  paths: Pick<AppPaths, 'media' | 'temporary'>;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  resolveHost?: DownloadHostResolver;
  maxBytes?: number;
}
export class OutputDownloader {
  private readonly fetcher;
  private readonly maxBytes: number;
  constructor(private readonly options: OutputDownloaderOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024 * 1024;
  }
  async download(outputId: string): Promise<OutputRecord> {
    const output = this.options.repository.output(outputId);
    if (!output?.remoteUrl) throw new Error('Download output is unavailable.');
    const attempt = this.options.repository.startDownload(outputId);
    let destination: string | null = null;
    let linked = false;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let temporary: string | null = null;
    try {
      const { root, directory } = await safeOutputDirectory(this.options.paths.media, output.jobId);
      temporary = resolvePathWithin(directory, `.${output.id}.${crypto.randomUUID()}.partial`);
      await assertSafeDirectory(root, directory);
      const target = await resolveDownloadTarget(output.remoteUrl, this.options.resolveHost);
      const response = this.options.fetch
        ? await this.fetcher(target.url, { redirect: 'manual' })
        : await requestPinnedDownload(target);
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error('Remote output redirects are not allowed.');
      }
      if (response.status === 404 || response.status === 410) {
        await response.body?.cancel().catch(() => undefined);
        throw Object.assign(new Error('Remote output has expired.'), { expired: true });
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Remote download failed with HTTP ${response.status}.`);
      }
      const contentEncoding = response.headers.get('content-encoding')?.trim().toLowerCase();
      if (contentEncoding && contentEncoding !== 'identity') {
        await response.body.cancel().catch(() => undefined);
        throw new Error('Remote output content encoding is not supported.');
      }
      const declaredHeader = response.headers.get('content-length');
      const declared = declaredHeader === null ? null : Number(declaredHeader);
      if (declared !== null && (!Number.isSafeInteger(declared) || declared < 0)) {
        await response.body.cancel().catch(() => undefined);
        throw new Error('Remote output Content-Length was invalid.');
      }
      if (declared !== null && Number.isFinite(declared) && declared > this.maxBytes)
        throw new Error('Remote output exceeds the local download limit.');
      handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600
      );
      reader = response.body.getReader();
      const hasher = new Bun.CryptoHasher('sha256');
      let total = 0;
      let prefix = new Uint8Array();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > this.maxBytes)
          throw new Error('Remote output exceeds the local download limit.');
        if (prefix.length < 16) {
          const needed = 16 - prefix.length;
          const merged = new Uint8Array(prefix.length + Math.min(needed, value.length));
          merged.set(prefix);
          merged.set(value.slice(0, needed), prefix.length);
          prefix = merged;
        }
        hasher.update(value);
        let offset = 0;
        while (offset < value.byteLength) {
          const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset);
          if (bytesWritten <= 0) throw new Error('Remote output could not be written completely.');
          offset += bytesWritten;
        }
      }
      if (total === 0) throw new Error('Remote output was empty.');
      if (declared !== null && Number.isFinite(declared) && declared >= 0 && declared !== total)
        throw new Error('Remote output length did not match Content-Length.');
      if (output.byteSize !== null && output.byteSize !== total)
        throw new Error('Remote output length did not match Poyo metadata.');
      const contentType = verifiedContentType(output, response.headers.get('content-type'), prefix);
      await handle.sync();
      await handle.close();
      handle = null;
      await assertSafeDirectory(root, directory);
      destination = resolvePathWithin(directory, safeName(output, contentType));
      try {
        await link(temporary, destination);
        linked = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error('Output destination already exists.');
        }
        throw error;
      }
      await rm(temporary);
      temporary = null;
      this.options.repository.verifyDownload(outputId, attempt, {
        path: destination,
        size: total,
        checksum: hasher.digest('hex'),
        signature: signature(prefix),
        contentType
      });
      linked = false;
      const verified = this.options.repository.output(outputId);
      if (!verified) throw new Error('Verified output was not found.');
      return verified;
    } catch (error) {
      await reader?.cancel().catch(() => undefined);
      await handle?.close().catch(() => undefined);
      if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
      if (linked && destination) await rm(destination, { force: true }).catch(() => undefined);
      this.options.repository.failDownload(
        outputId,
        attempt,
        safeErrorSummary(error),
        (error as { expired?: boolean }).expired === true
      );
      throw error;
    }
  }
}
