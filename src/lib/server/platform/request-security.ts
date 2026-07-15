const jsonContentType = /^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i;

export type RequestSecurityCode =
  | 'origin_required'
  | 'origin_mismatch'
  | 'cross_site'
  | 'invalid_content_type'
  | 'invalid_content_length'
  | 'body_too_large'
  | 'invalid_multipart'
  | 'invalid_json';

export class RequestSecurityError extends Error {
  constructor(
    readonly code: RequestSecurityCode,
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'RequestSecurityError';
  }
}

export interface ReadJsonOptions {
  maxBytes?: number;
}

export async function readSameOriginJson<T>(
  request: Request,
  options: ReadJsonOptions = {}
): Promise<T> {
  const expectedOrigin = new URL(request.url).origin;
  const origin = request.headers.get('origin');
  if (!origin) {
    throw new RequestSecurityError('origin_required', 403, 'An Origin header is required.');
  }
  if (origin !== expectedOrigin) {
    throw new RequestSecurityError('origin_mismatch', 403, 'Request origin does not match.');
  }

  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite === 'cross-site') {
    throw new RequestSecurityError('cross_site', 403, 'Cross-site requests are not allowed.');
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!jsonContentType.test(contentType)) {
    throw new RequestSecurityError(
      'invalid_content_type',
      415,
      'Mutating JSON routes require application/json.'
    );
  }

  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const declaredLength = request.headers.get('content-length');
  if (declaredLength) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RequestSecurityError('invalid_content_length', 400, 'Invalid Content-Length.');
    }
    if (length > maxBytes) {
      throw new RequestSecurityError('body_too_large', 413, 'Request body is too large.');
    }
  }

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maxBytes) {
    throw new RequestSecurityError('body_too_large', 413, 'Request body is too large.');
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new RequestSecurityError('invalid_json', 400, 'Request body is not valid JSON.');
  }
}
