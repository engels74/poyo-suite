import type { Database } from 'bun:sqlite';
import { basename } from 'node:path';
import { RequestSecurityError } from '../platform/request-security';
import {
  assertPrivateMediaRequest,
  MediaRangeError,
  parseByteRange,
  privateMediaHeaders,
  safeLocalMediaPath
} from './files';

const allowedTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
  'video/quicktime'
]);

export class MediaActionError extends Error {
  constructor(
    readonly code: 'local_media_unavailable' | 'native_action_unavailable' | 'native_action_failed',
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'MediaActionError';
  }
}

export interface VerifiedMediaOutput {
  outputId: string;
  path: string;
  fileName: string;
  contentType: string;
  size: number;
}

export async function resolveVerifiedMediaOutput(
  database: Database,
  mediaRoots: string | readonly string[],
  outputId: string
): Promise<VerifiedMediaOutput> {
  const output = database
    .query<
      { local_path: string | null; content_type: string | null; download_state: string },
      [string]
    >('SELECT local_path,content_type,download_state FROM job_outputs WHERE id=?')
    .get(outputId);
  if (!output?.local_path || output.download_state !== 'verified') {
    throw new MediaActionError(
      'local_media_unavailable',
      404,
      'This output is not available locally.'
    );
  }
  const path = await safeLocalMediaPath(mediaRoots, output.local_path).catch(() => {
    throw new MediaActionError(
      'local_media_unavailable',
      404,
      'This output is not available locally.'
    );
  });
  const file = Bun.file(path);
  if (!(await file.exists()) || file.size <= 0) {
    throw new MediaActionError(
      'local_media_unavailable',
      404,
      'This output is not available locally.'
    );
  }
  const contentType =
    output.content_type && allowedTypes.has(output.content_type)
      ? output.content_type
      : allowedTypes.has(file.type)
        ? file.type
        : 'application/octet-stream';
  return {
    outputId,
    path,
    fileName: basename(path),
    contentType,
    size: file.size
  };
}

function contentDisposition(fileName: string): string {
  const fallback =
    fileName
      .normalize('NFKD')
      .replace(/[^\x20-\x7e]/g, '')
      .replace(/["\\]/g, '_')
      .trim() || 'output';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export async function serveVerifiedMediaOutput(
  request: Request,
  database: Database,
  mediaRoots: string | readonly string[],
  outputId: string,
  options: { head?: boolean; attachment?: boolean } = {}
): Promise<Response> {
  let size: number | null = null;
  try {
    assertPrivateMediaRequest(request);
    const output = await resolveVerifiedMediaOutput(database, mediaRoots, outputId);
    size = output.size;
    const file = Bun.file(output.path);
    const range = parseByteRange(request.headers.get('range'), output.size);
    const headers = privateMediaHeaders(
      output.contentType,
      range ? range.end - range.start + 1 : output.size
    );
    if (options.attachment) {
      headers.set('cache-control', 'private, no-store');
      headers.set('content-disposition', contentDisposition(output.fileName));
    }
    if (range) {
      headers.set('content-range', `bytes ${range.start}-${range.end}/${output.size}`);
      return new Response(options.head ? null : file.slice(range.start, range.end + 1), {
        status: 206,
        headers
      });
    }
    return new Response(options.head ? null : file, { headers });
  } catch (error) {
    if (error instanceof MediaRangeError) {
      const headers = new Headers({
        'cross-origin-resource-policy': 'same-origin',
        'x-content-type-options': 'nosniff'
      });
      if (error.status === 416 && size !== null) headers.set('content-range', `bytes */${size}`);
      return new Response(error.message, { status: error.status, headers });
    }
    return new Response('Local media is unavailable.', { status: 404 });
  }
}

export function mediaActionHttpError(error: unknown): Response {
  if (error instanceof RequestSecurityError || error instanceof MediaActionError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status }
    );
  }
  return Response.json(
    {
      error: {
        code: 'native_action_failed',
        message: 'The local media action could not be completed.'
      }
    },
    { status: 400 }
  );
}
