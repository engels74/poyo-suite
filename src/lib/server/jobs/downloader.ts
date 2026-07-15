import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, realpath, rm } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { safeErrorSummary } from '../diagnostics/redaction';
import { syncDirectory } from '../media/filesystem-boundary';
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
const RECEIPT_MAX_BYTES = 4_096;

interface DownloadVerification {
  path: string;
  size: number;
  checksum: string;
  signature: string;
  contentType: string;
}

interface PublicationReceipt extends Omit<DownloadVerification, 'path'> {
  version: 1;
  outputId: string;
  fileName: string;
}

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

function positiveDuration(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? (value as number) : fallback;
}

function collisionName(name: string): string {
  const extension = extname(name);
  return `${basename(name, extension)}-${crypto.randomUUID().slice(0, 8)}${extension}`;
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

function receiptPath(directory: string, outputId: string): string {
  return resolvePathWithin(directory, `.${outputId}.published.json`);
}

function isPublicationReceipt(value: unknown, output: OutputRecord): value is PublicationReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Partial<PublicationReceipt>;
  const prefix = `${output.outputOrder}-${output.id.slice(0, 8)}-`;
  return (
    receipt.version === 1 &&
    receipt.outputId === output.id &&
    typeof receipt.fileName === 'string' &&
    receipt.fileName === basename(receipt.fileName) &&
    receipt.fileName.startsWith(prefix) &&
    typeof receipt.size === 'number' &&
    Number.isSafeInteger(receipt.size) &&
    receipt.size > 0 &&
    typeof receipt.checksum === 'string' &&
    /^[0-9a-f]{64}$/.test(receipt.checksum) &&
    typeof receipt.signature === 'string' &&
    /^[0-9a-f]{2,32}$/.test(receipt.signature) &&
    typeof receipt.contentType === 'string' &&
    mediaKinds[receipt.contentType] === output.mediaKind &&
    receipt.fileName.endsWith(extensions[receipt.contentType] ?? '\0')
  );
}

async function readReceipt(
  directory: string,
  output: OutputRecord
): Promise<PublicationReceipt | null> {
  const path = receiptPath(directory, output.id);
  const details = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!details) return null;
  if (!details.isFile() || details.isSymbolicLink() || details.size > RECEIPT_MAX_BYTES) {
    throw new Error('Published output receipt is not a safe regular file.');
  }
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!isPublicationReceipt(value, output)) {
    throw new Error('Published output receipt is invalid.');
  }
  return value;
}

async function removeReceipt(directory: string, outputId: string): Promise<void> {
  const path = receiptPath(directory, outputId);
  const details = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!details) return;
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error('Published output receipt is not a safe regular file.');
  }
  await rm(path);
  await syncDirectory(directory);
}

async function writeReceipt(directory: string, receipt: PublicationReceipt): Promise<void> {
  const path = receiptPath(directory, receipt.outputId);
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await handle.writeFile(`${JSON.stringify(receipt)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(directory);
}

async function inspectPublishedFile(
  root: string,
  directory: string,
  output: OutputRecord,
  fileName: string,
  maxBytes: number
): Promise<DownloadVerification> {
  const path = resolvePathWithin(directory, fileName);
  const details = await lstat(path);
  if (
    !details.isFile() ||
    details.isSymbolicLink() ||
    details.size <= 0 ||
    details.size > maxBytes
  ) {
    throw new Error('Published output is not a safe bounded regular file.');
  }
  const canonical = await realpath(path);
  resolvePathWithin(root, canonical);
  const reader = Bun.file(canonical).stream().getReader();
  const hasher = new Bun.CryptoHasher('sha256');
  let total = 0;
  let prefix = new Uint8Array();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('Published output exceeds the local download limit.');
      if (prefix.length < 16) {
        const needed = 16 - prefix.length;
        const merged = new Uint8Array(prefix.length + Math.min(needed, value.length));
        merged.set(prefix);
        merged.set(value.slice(0, needed), prefix.length);
        prefix = merged;
      }
      hasher.update(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (total !== details.size) throw new Error('Published output size changed during inspection.');
  if (output.byteSize !== null && output.byteSize !== total) {
    throw new Error('Published output length did not match Poyo metadata.');
  }
  const contentType = verifiedContentType(output, null, prefix);
  return {
    path: canonical,
    size: total,
    checksum: hasher.digest('hex'),
    signature: signature(prefix),
    contentType
  };
}

function receiptFor(
  output: OutputRecord,
  fileName: string,
  verification: Omit<DownloadVerification, 'path'>
): PublicationReceipt {
  return { version: 1, outputId: output.id, fileName, ...verification };
}

function sameVerification(
  left: Omit<DownloadVerification, 'path'>,
  right: Omit<DownloadVerification, 'path'>
): boolean {
  return (
    left.size === right.size &&
    left.checksum === right.checksum &&
    left.signature === right.signature &&
    left.contentType === right.contentType
  );
}

async function publishOutput(
  root: string,
  directory: string,
  temporary: string,
  output: OutputRecord,
  verification: Omit<DownloadVerification, 'path'>,
  maxBytes: number
): Promise<DownloadVerification> {
  let fileName = safeName(output, verification.contentType);
  for (let collision = 0; collision < 8; collision += 1) {
    await assertSafeDirectory(root, directory);
    const destination = resolvePathWithin(directory, fileName);
    await writeReceipt(directory, receiptFor(output, fileName, verification));
    let linked = false;
    try {
      await link(temporary, destination);
      linked = true;
      await syncDirectory(directory);
      return { path: destination, ...verification };
    } catch (error) {
      // If publication succeeded but the directory sync reported an error, retain the already
      // durable receipt. Recovery will verify either the linked file or its absence safely.
      if (linked) throw error;
      await removeReceipt(directory, output.id);
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const details = await lstat(destination);
      if (!details.isFile() || details.isSymbolicLink()) {
        throw new Error('Output destination already exists and is not a safe regular file.');
      }
      const existing = await inspectPublishedFile(
        root,
        directory,
        output,
        fileName,
        maxBytes
      ).catch(() => null);
      if (existing && sameVerification(existing, verification)) {
        await writeReceipt(directory, receiptFor(output, fileName, verification));
        return existing;
      }
      fileName = collisionName(safeName(output, verification.contentType));
    }
  }
  throw new Error('A collision-safe output destination could not be created.');
}

function abortedReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Remote output download was aborted.');
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortedReason(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortedReason(signal));
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
  });
}

function readWithIdleDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
  signal: AbortSignal
): ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']> {
  if (signal.aborted) return Promise.reject(abortedReason(signal));
  return new Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>>(
    (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Remote output body idle deadline exceeded.')),
        idleTimeoutMs
      );
      timer.unref();
      const abort = () => reject(abortedReason(signal));
      signal.addEventListener('abort', abort, { once: true });
      reader.read().then(
        (result) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          resolve(result);
        },
        (error) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          reject(error);
        }
      );
    }
  );
}

export interface OutputDownloaderOptions {
  repository: JobRepository;
  paths: Pick<AppPaths, 'media' | 'temporary'>;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  resolveHost?: DownloadHostResolver;
  maxBytes?: number;
  connectTimeoutMs?: number;
  headerTimeoutMs?: number;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
  afterPublish?: (publication: { outputId: string; path: string }) => void | Promise<void>;
}
export class OutputDownloader {
  private readonly fetcher;
  private readonly maxBytes: number;
  private readonly connectTimeoutMs: number;
  private readonly headerTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly totalTimeoutMs: number;
  constructor(private readonly options: OutputDownloaderOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024 * 1024;
    this.connectTimeoutMs = positiveDuration(options.connectTimeoutMs, 30_000);
    this.headerTimeoutMs = positiveDuration(options.headerTimeoutMs, 30_000);
    this.idleTimeoutMs = positiveDuration(options.idleTimeoutMs, 30_000);
    this.totalTimeoutMs = positiveDuration(options.totalTimeoutMs, 30 * 60_000);
  }
  async download(outputId: string): Promise<OutputRecord> {
    const output = this.options.repository.output(outputId);
    if (!output?.remoteUrl) throw new Error('Download output is unavailable.');
    const attempt = this.options.repository.startDownload(outputId);
    const abortController = new AbortController();
    const totalTimer = setTimeout(
      () => abortController.abort(new Error('Remote output total deadline exceeded.')),
      this.totalTimeoutMs
    );
    totalTimer.unref();
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let temporary: string | null = null;
    try {
      const { root, directory } = await safeOutputDirectory(this.options.paths.media, output.jobId);
      const receipt = await readReceipt(directory, output);
      if (receipt) {
        const recovered = await inspectPublishedFile(
          root,
          directory,
          output,
          receipt.fileName,
          this.maxBytes
        ).catch(() => null);
        if (recovered && sameVerification(recovered, receipt)) {
          this.options.repository.verifyDownload(outputId, attempt, recovered);
          await removeReceipt(directory, output.id).catch(() => undefined);
          const verified = this.options.repository.output(outputId);
          if (!verified) throw new Error('Recovered output was not found.');
          return verified;
        }
        await removeReceipt(directory, output.id);
      }
      temporary = resolvePathWithin(directory, `.${output.id}.${crypto.randomUUID()}.partial`);
      await assertSafeDirectory(root, directory);
      const target = await withAbort(
        resolveDownloadTarget(output.remoteUrl, this.options.resolveHost),
        abortController.signal
      );
      const response = await withAbort(
        this.options.fetch
          ? this.fetcher(target.url, {
              redirect: 'manual',
              signal: abortController.signal
            })
          : requestPinnedDownload(target, {
              signal: abortController.signal,
              connectTimeoutMs: this.connectTimeoutMs,
              headerTimeoutMs: this.headerTimeoutMs
            }),
        abortController.signal
      );
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
        const { done, value } = await readWithIdleDeadline(
          reader,
          this.idleTimeoutMs,
          abortController.signal
        );
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
      const verification = {
        size: total,
        checksum: hasher.digest('hex'),
        signature: signature(prefix),
        contentType
      };
      await handle.sync();
      await handle.close();
      handle = null;
      await assertSafeDirectory(root, directory);
      const published = await publishOutput(
        root,
        directory,
        temporary,
        output,
        verification,
        this.maxBytes
      );
      await rm(temporary);
      temporary = null;
      await this.options.afterPublish?.({ outputId, path: published.path });
      this.options.repository.verifyDownload(outputId, attempt, published);
      await removeReceipt(directory, output.id).catch(() => undefined);
      const verified = this.options.repository.output(outputId);
      if (!verified) throw new Error('Verified output was not found.');
      return verified;
    } catch (error) {
      if (!abortController.signal.aborted) abortController.abort(error);
      const failure = abortController.signal.aborted
        ? abortedReason(abortController.signal)
        : error;
      await reader?.cancel().catch(() => undefined);
      await handle?.close().catch(() => undefined);
      if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
      this.options.repository.failDownload(
        outputId,
        attempt,
        safeErrorSummary(failure),
        (failure as { expired?: boolean }).expired === true
      );
      throw failure;
    } finally {
      clearTimeout(totalTimer);
    }
  }
}
