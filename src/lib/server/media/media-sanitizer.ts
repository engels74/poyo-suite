import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, rm } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import type { MediaPrivacySettings } from '../../features/settings/contracts';
import { readExactPositioned } from './filesystem-boundary';

const SAFE_MESSAGE = 'The local media could not be sanitized safely.';
const TOOL_TIMEOUT_MS = 120_000;
const TOOL_OUTPUT_LIMIT = 8 * 1024 * 1024;
const PROFILE_OUTPUT_LIMIT = 4 * 1024 * 1024;
const IMAGE_MAGICK_LIMITS = [
  '-limit',
  'area',
  '256MP',
  '-limit',
  'memory',
  '512MiB',
  '-limit',
  'map',
  '1GiB',
  '-limit',
  'disk',
  '2GiB',
  '-limit',
  'file',
  '64',
  '-limit',
  'thread',
  '2',
  '-limit',
  'time',
  '90'
];

const imageTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const videoMuxers: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-msvideo': 'avi',
  'video/x-matroska': 'matroska'
};

const mimeExtensions: Record<string, string> = {
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

export interface MediaSanitizationInput {
  inputPath: string;
  outputPath: string;
  mimeType: string;
  mediaKind: 'image' | 'video';
  settings: MediaPrivacySettings;
  maxOutputBytes: number;
}

export type MediaSanitizer = (input: MediaSanitizationInput) => Promise<void>;

export interface MediaCommand {
  cmd: string[];
  timeoutMs?: number;
  maxBufferBytes?: number;
}

export interface MediaCommandResult {
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export type MediaCommandRunner = (command: MediaCommand) => Promise<MediaCommandResult>;

export class MediaSanitizationError extends Error {
  readonly code = 'media_sanitization_failed' as const;

  constructor() {
    super(SAFE_MESSAGE);
    this.name = 'MediaSanitizationError';
  }
}

function fail(): never {
  throw new MediaSanitizationError();
}

async function assertVacantOutputPath(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    fail();
  }
  fail();
}

export const runMediaCommand: MediaCommandRunner = async ({
  cmd,
  timeoutMs = TOOL_TIMEOUT_MS,
  maxBufferBytes = TOOL_OUTPUT_LIMIT
}) => {
  if (cmd.length === 0 || maxBufferBytes <= 0 || timeoutMs <= 0) fail();
  const [executable, ...arguments_] = cmd;
  if (!executable) fail();
  try {
    return await new Promise<MediaCommandResult>((resolve, reject) => {
      const child = execFile(
        executable,
        arguments_,
        {
          encoding: 'buffer',
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: maxBufferBytes,
          windowsHide: true
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ stdout: new Uint8Array(stdout), stderr: new Uint8Array(stderr) });
        }
      );
      child.stdin?.end();
    });
  } catch {
    fail();
  }
};

function text(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function parseJson<T>(bytes: Uint8Array): T {
  try {
    return JSON.parse(text(bytes)) as T;
  } catch {
    fail();
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function toolText(
  runner: MediaCommandRunner,
  cmd: string[],
  maxBufferBytes = TOOL_OUTPUT_LIMIT
): Promise<string> {
  return text((await runner({ cmd, maxBufferBytes, timeoutMs: TOOL_TIMEOUT_MS })).stdout);
}

function requireVersion(output: string, pattern: RegExp, minimum: [number, number]): void {
  const match = pattern.exec(output);
  if (!match) fail();
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < minimum[0] || (major === minimum[0] && minor < minimum[1])) fail();
}

async function requireExifTool(runner: MediaCommandRunner): Promise<void> {
  requireVersion(await toolText(runner, ['exiftool', '-ver']), /^(\d+)\.(\d+)/, [13, 55]);
}

async function requireImageMagick(runner: MediaCommandRunner): Promise<void> {
  requireVersion(
    await toolText(runner, ['magick', '-version']),
    /ImageMagick (\d+)\.(\d+)/,
    [7, 1]
  );
}

async function requireVideoTools(runner: MediaCommandRunner): Promise<void> {
  const [ffmpeg, ffprobe] = await Promise.all([
    toolText(runner, ['ffmpeg', '-version']),
    toolText(runner, ['ffprobe', '-version'])
  ]);
  requireVersion(ffmpeg, /ffmpeg version (\d+)\.(\d+)/, [8, 1]);
  requireVersion(ffprobe, /ffprobe version (\d+)\.(\d+)/, [8, 1]);
}

type MetadataRecord = Record<string, unknown>;

async function metadata(runner: MediaCommandRunner, path: string): Promise<MetadataRecord> {
  const value = parseJson<unknown>(
    (
      await runner({
        cmd: [
          'exiftool',
          '-json',
          '-G0',
          '-a',
          '-u',
          '-struct',
          '-ee',
          '-EXIF:all',
          '-IPTC:all',
          '-XMP:all',
          '-Photoshop:all',
          path
        ],
        timeoutMs: TOOL_TIMEOUT_MS,
        maxBufferBytes: TOOL_OUTPUT_LIMIT
      })
    ).stdout
  );
  if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== 'object')
    fail();
  const record = { ...(value[0] as MetadataRecord) };
  delete record.SourceFile;
  delete record['ExifTool::ExifTool:ExifToolVersion'];
  return record;
}

function groupEntries(record: MetadataRecord, group: 'EXIF' | 'IPTC' | 'XMP' | 'Photoshop') {
  const prefix = `${group.toUpperCase()}:`;
  return Object.entries(record).filter(([key]) => key.toUpperCase().startsWith(prefix));
}

function groupValue(
  record: MetadataRecord,
  group: 'EXIF' | 'IPTC' | 'XMP' | 'Photoshop',
  omitOrientation = false
): string {
  return canonical(
    Object.fromEntries(
      groupEntries(record, group).filter(
        ([key]) => !omitOrientation || !key.toLowerCase().endsWith(':orientation')
      )
    )
  );
}

function metadataPolicies(
  settings: MediaPrivacySettings
): Array<['EXIF' | 'IPTC' | 'XMP' | 'Photoshop', boolean]> {
  return [
    ['EXIF', settings.removeExif],
    ['IPTC', settings.removeIptc],
    ['XMP', settings.removeXmp],
    ['Photoshop', settings.removePhotoshop8bim]
  ];
}

function assertMetadataPolicies(
  before: MetadataRecord,
  after: MetadataRecord,
  settings: MediaPrivacySettings,
  omitBeforeExifOrientation = false
): void {
  for (const [group, remove] of metadataPolicies(settings)) {
    if (remove) {
      if (groupEntries(after, group).length !== 0) fail();
    } else if (
      groupValue(before, group, omitBeforeExifOrientation && group === 'EXIF') !==
      groupValue(after, group)
    ) {
      fail();
    }
  }
}

async function iccProfile(runner: MediaCommandRunner, path: string): Promise<Uint8Array> {
  return (
    await runner({
      cmd: ['exiftool', '-b', '-ICC_Profile', path],
      timeoutMs: TOOL_TIMEOUT_MS,
      maxBufferBytes: PROFILE_OUTPUT_LIMIT
    })
  ).stdout;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

interface ImageFrame {
  format: string;
  width: number;
  height: number;
  channels: string;
  orientation: string;
  delay: number;
  disposal: string;
}

async function identify(runner: MediaCommandRunner, path: string): Promise<ImageFrame[]> {
  const output = await toolText(runner, [
    'magick',
    'identify',
    ...IMAGE_MAGICK_LIMITS,
    '-quiet',
    '-format',
    '%m\t%w\t%h\t%[channels]\t%[orientation]\t%T\t%D\n',
    path
  ]);
  const frames = output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const fields = line.split('\t');
      if (fields.length !== 7) fail();
      const width = Number(fields[1]);
      const height = Number(fields[2]);
      const delay = Number(fields[5]);
      if (![width, height, delay].every(Number.isFinite) || width <= 0 || height <= 0 || delay < 0)
        fail();
      return {
        format: fields[0] as string,
        width,
        height,
        channels: fields[3] as string,
        orientation: fields[4] as string,
        delay,
        disposal: fields[6] as string
      };
    });
  if (frames.length === 0) fail();
  return frames;
}

async function numericOrientation(runner: MediaCommandRunner, path: string): Promise<number> {
  const output = (await toolText(runner, ['exiftool', '-s3', '-n', '-Orientation', path])).trim();
  if (!output) return 1;
  const value = Number(output);
  if (!Number.isInteger(value) || value < 1 || value > 8) fail();
  return value;
}

function imageFramesMatch(before: ImageFrame[], after: ImageFrame[], orientation: number): boolean {
  if (before.length !== after.length) return false;
  const swapsDimensions = orientation >= 5 && orientation <= 8;
  return before.every((frame, index) => {
    const candidate = after[index];
    if (!candidate) return false;
    return (
      frame.format === candidate.format &&
      (swapsDimensions ? frame.width === candidate.height : frame.width === candidate.width) &&
      (swapsDimensions ? frame.height === candidate.width : frame.height === candidate.height) &&
      frame.channels === candidate.channels &&
      frame.delay === candidate.delay &&
      frame.disposal === candidate.disposal
    );
  });
}

function temporaryPath(outputPath: string, label: string, mimeType: string): string {
  const extension = mimeExtensions[mimeType];
  if (!extension) fail();
  return join(dirname(outputPath), `${crypto.randomUUID()}.${label}${extension}`);
}

async function validateOutput(input: MediaSanitizationInput): Promise<void> {
  const details = await lstat(input.outputPath).catch(() => null);
  if (
    !details?.isFile() ||
    details.isSymbolicLink() ||
    details.size <= 0 ||
    details.size > input.maxOutputBytes
  )
    fail();
  const handle = await open(input.outputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const header = new Uint8Array(Math.min(16, details.size));
    await readExactPositioned(handle, header, 0);
    if (!hasSignature(input.mimeType, header)) fail();
  } finally {
    await handle.close();
  }
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
  if (type === 'video/mp4') return ascii(4, 8) === 'ftyp';
  if (type === 'video/quicktime') return ascii(4, 8) === 'ftyp' && ascii(8, 12) === 'qt  ';
  if (type === 'video/x-msvideo') return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'AVI ';
  if (type === 'video/webm' || type === 'video/x-matroska')
    return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  return false;
}

async function sanitizeImage(
  runner: MediaCommandRunner,
  input: MediaSanitizationInput,
  intermediates: string[]
): Promise<void> {
  await Promise.all([requireExifTool(runner), requireImageMagick(runner)]);
  const [beforeMetadata, beforeProfile, beforeFrames, orientation] = await Promise.all([
    metadata(runner, input.inputPath),
    iccProfile(runner, input.inputPath),
    identify(runner, input.inputPath),
    numericOrientation(runner, input.inputPath)
  ]);
  const transformed = input.settings.removeExif && orientation !== 1;
  if (transformed && beforeFrames.length !== 1) fail();

  let basePath = input.inputPath;
  if (transformed) {
    basePath = temporaryPath(input.outputPath, 'oriented', input.mimeType);
    intermediates.push(basePath);
    await runner({
      cmd: ['magick', ...IMAGE_MAGICK_LIMITS, input.inputPath, '-auto-orient', basePath],
      timeoutMs: TOOL_TIMEOUT_MS,
      maxBufferBytes: TOOL_OUTPUT_LIMIT
    });
  }

  const command = ['exiftool', '-all='];
  const retainedTags: string[] = [];
  if (!input.settings.removeExif) retainedTags.push('-EXIF:all');
  if (!input.settings.removeIptc) retainedTags.push('-IPTC:all');
  if (!input.settings.removeXmp) retainedTags.push('-XMP:all');
  if (!input.settings.removePhotoshop8bim) retainedTags.push('-Photoshop:all');
  if (!input.settings.removeColorProfile) retainedTags.push('-ICC_Profile');
  if (transformed) retainedTags.push('--Orientation');
  if (retainedTags.length > 0) {
    command.push('-tagsFromFile', input.inputPath, ...retainedTags);
  }
  command.push('-o', input.outputPath, basePath);
  await runner({ cmd: command, timeoutMs: TOOL_TIMEOUT_MS, maxBufferBytes: TOOL_OUTPUT_LIMIT });
  await validateOutput(input);

  const [afterMetadata, afterProfile, afterFrames, afterOrientation] = await Promise.all([
    metadata(runner, input.outputPath),
    iccProfile(runner, input.outputPath),
    identify(runner, input.outputPath),
    numericOrientation(runner, input.outputPath)
  ]);
  assertMetadataPolicies(beforeMetadata, afterMetadata, input.settings, transformed);
  if (input.settings.removeColorProfile) {
    if (afterProfile.byteLength !== 0) fail();
  } else if (!equalBytes(beforeProfile, afterProfile)) {
    fail();
  }
  if (!imageFramesMatch(beforeFrames, afterFrames, transformed ? orientation : 1)) fail();
  if (transformed && afterOrientation !== 1) fail();
}

interface ProbeStream {
  index?: number;
  codec_name?: string;
  codec_type?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  sample_rate?: string;
  channels?: number;
  time_base?: string;
  duration?: string;
  color_range?: string;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  disposition?: Record<string, number>;
  side_data_list?: unknown[];
  tags?: Record<string, string>;
}

interface ProbeResult {
  streams?: ProbeStream[];
  chapters?: unknown[];
  format?: { duration?: string; tags?: Record<string, string> };
}

async function probe(runner: MediaCommandRunner, path: string): Promise<ProbeResult> {
  const value = parseJson<ProbeResult>(
    (
      await runner({
        cmd: [
          'ffprobe',
          '-v',
          'error',
          '-protocol_whitelist',
          'file,pipe',
          '-threads',
          '2',
          '-show_streams',
          '-show_format',
          '-show_chapters',
          '-of',
          'json',
          path
        ],
        timeoutMs: TOOL_TIMEOUT_MS,
        maxBufferBytes: TOOL_OUTPUT_LIMIT
      })
    ).stdout
  );
  if (!value || typeof value !== 'object' || !Array.isArray(value.streams)) fail();
  return value;
}

function durationClose(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined && right === undefined) return true;
  const before = Number(left);
  const after = Number(right);
  return Number.isFinite(before) && Number.isFinite(after) && Math.abs(before - after) <= 0.05;
}

function streamsMatch(before: ProbeStream[], after: ProbeStream[]): boolean {
  if (before.length !== after.length) return false;
  const keys: Array<keyof ProbeStream> = [
    'index',
    'codec_name',
    'codec_type',
    'width',
    'height',
    'pix_fmt',
    'sample_rate',
    'channels',
    'time_base',
    'color_range',
    'color_space',
    'color_transfer',
    'color_primaries',
    'side_data_list'
  ];
  return before.every((stream, index) => {
    const candidate = after[index];
    return (
      !!candidate &&
      keys.every((key) => canonical(stream[key]) === canonical(candidate[key])) &&
      durationClose(stream.duration, candidate.duration)
    );
  });
}

function assertOrdinaryStreams(streams: ProbeStream[]): void {
  if (streams.length === 0) fail();
  for (const stream of streams) {
    if (stream.codec_type !== 'audio' && stream.codec_type !== 'video') fail();
    if (stream.disposition?.attached_pic || stream.disposition?.timed_thumbnails) fail();
  }
}

function assertNoChaptersOrTags(result: ProbeResult): void {
  if ((result.chapters?.length ?? 0) !== 0) fail();
  const allowedFormatTags = new Set(['major_brand', 'minor_version', 'compatible_brands']);
  for (const [key, value] of Object.entries(result.format?.tags ?? {})) {
    const normalized = key.toLowerCase();
    if (!allowedFormatTags.has(normalized) && !(normalized === 'encoder' && value === 'Lavf'))
      fail();
  }
  for (const stream of result.streams ?? []) {
    const tags = stream.tags ?? {};
    const expectedHandler = stream.codec_type === 'video' ? 'VideoHandler' : 'SoundHandler';
    for (const [key, value] of Object.entries(tags)) {
      const normalized = key.toLowerCase();
      if (normalized === 'language' && value === 'und') continue;
      if (normalized === 'handler_name' && value === expectedHandler) continue;
      if (normalized === 'vendor_id' && (value === 'FFMP' || value === '[0][0][0][0]')) continue;
      if (normalized === 'duration' && /^\d{2}:\d{2}:\d{2}\.\d{9}$/.test(value)) continue;
      fail();
    }
  }
}

async function sanitizeVideo(
  runner: MediaCommandRunner,
  input: MediaSanitizationInput
): Promise<void> {
  const muxer = videoMuxers[input.mimeType];
  if (!muxer) fail();
  await Promise.all([requireExifTool(runner), requireVideoTools(runner)]);
  const [beforeProbe, beforeMetadata] = await Promise.all([
    probe(runner, input.inputPath),
    metadata(runner, input.inputPath)
  ]);
  const beforeStreams = beforeProbe.streams ?? [];
  assertOrdinaryStreams(beforeStreams);
  await runner({
    cmd: [
      'ffmpeg',
      '-nostdin',
      '-v',
      'error',
      '-xerror',
      '-protocol_whitelist',
      'file,pipe',
      '-i',
      input.inputPath,
      '-map',
      '0',
      '-map_metadata',
      '-1',
      '-map_chapters',
      '-1',
      '-c',
      'copy',
      '-fflags',
      '+bitexact',
      '-flags:v',
      '+bitexact',
      '-flags:a',
      '+bitexact',
      '-metadata',
      'encoder=',
      '-fs',
      String(input.maxOutputBytes),
      '-f',
      muxer,
      '-n',
      input.outputPath
    ],
    timeoutMs: TOOL_TIMEOUT_MS,
    maxBufferBytes: TOOL_OUTPUT_LIMIT
  });
  const retainedTags = metadataPolicies(input.settings)
    .filter(([, remove]) => !remove)
    .map(([group]) => `-${group}:all`);
  if (retainedTags.length > 0) {
    await runner({
      cmd: [
        'exiftool',
        '-overwrite_original',
        '-tagsFromFile',
        input.inputPath,
        ...retainedTags,
        input.outputPath
      ],
      timeoutMs: TOOL_TIMEOUT_MS,
      maxBufferBytes: TOOL_OUTPUT_LIMIT
    });
  }
  await validateOutput(input);
  const [afterProbe, afterMetadata] = await Promise.all([
    probe(runner, input.outputPath),
    metadata(runner, input.outputPath)
  ]);
  const afterStreams = afterProbe.streams ?? [];
  assertOrdinaryStreams(afterStreams);
  assertNoChaptersOrTags(afterProbe);
  assertMetadataPolicies(beforeMetadata, afterMetadata, input.settings);
  if (!streamsMatch(beforeStreams, afterStreams)) fail();
  if (!durationClose(beforeProbe.format?.duration, afterProbe.format?.duration)) fail();
  await runner({
    cmd: [
      'ffmpeg',
      '-nostdin',
      '-v',
      'error',
      '-xerror',
      '-protocol_whitelist',
      'file,pipe',
      '-threads',
      '2',
      '-i',
      input.outputPath,
      '-map',
      '0',
      '-f',
      'null',
      '-'
    ],
    timeoutMs: TOOL_TIMEOUT_MS,
    maxBufferBytes: TOOL_OUTPUT_LIMIT
  });
}

export function createMediaSanitizer(runner: MediaCommandRunner): MediaSanitizer {
  return async (input) => {
    if (
      !Number.isSafeInteger(input.maxOutputBytes) ||
      input.maxOutputBytes <= 0 ||
      input.inputPath === input.outputPath ||
      extname(input.inputPath).includes('\0') ||
      extname(input.outputPath).includes('\0')
    )
      fail();
    await assertVacantOutputPath(input.outputPath);
    const intermediates: string[] = [];
    try {
      if (input.mediaKind === 'image' && imageTypes.has(input.mimeType)) {
        await sanitizeImage(runner, input, intermediates);
      } else if (input.mediaKind === 'video' && input.mimeType in videoMuxers) {
        await sanitizeVideo(runner, input);
      } else {
        fail();
      }
    } catch {
      await rm(input.outputPath, { force: true }).catch(() => undefined);
      fail();
    } finally {
      await Promise.all(
        intermediates.map((path) => rm(path, { force: true }).catch(() => undefined))
      );
    }
  };
}

export const sanitizeMedia: MediaSanitizer = createMediaSanitizer(runMediaCommand);
