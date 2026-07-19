import {
  defaultRetryPolicy,
  parseRetryAfter,
  retryDelay,
  systemClock,
  systemSleeper,
  type RetryPolicy
} from './backoff';
import { malformedResponseError, networkError, normalizePoyoError, PoyoError } from './errors';
import {
  POYO_API_BASE_URL,
  type Clock,
  type PoyoMetadataLogger,
  type PoyoOperation,
  type PoyoRequestMetadata,
  type Sleeper
} from './types';

export interface TransportRequest {
  operation: Exclude<PoyoOperation, 'configuration'>;
  method: 'GET' | 'POST';
  path: string;
  body?: BodyInit;
  bodyKind?: 'none' | 'json' | 'multipart';
  contentType?: string;
  safeToRetry: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  beforeDispatch?: () => Promise<void> | void;
}

export type PoyoFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface PoyoTransportOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: PoyoFetch;
  clock?: Clock;
  sleeper?: Sleeper;
  random?: () => number;
  logger?: PoyoMetadataLogger;
  retryPolicy?: RetryPolicy;
  defaultTimeoutMs?: number;
  maxResponseBytes?: number;
  beforeRequest?: (operation: Exclude<PoyoOperation, 'configuration'>) => Promise<void> | void;
}

const noopLogger: PoyoMetadataLogger = {
  requestStarted: () => undefined,
  requestFinished: () => undefined,
  requestFailed: () => undefined
};

async function safelyLog(operation: () => Promise<void> | void): Promise<void> {
  try {
    await operation();
  } catch {
    // Transport correctness must not depend on local diagnostics availability.
  }
}

async function readBoundedJson(
  response: Response,
  operation: Exclude<PoyoOperation, 'configuration'>,
  maxBytes: number
): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    if (!response.ok) return null;
    throw malformedResponseError(
      operation,
      'Poyo returned a response larger than the local limit.'
    );
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      if (!response.ok) return null;
      throw malformedResponseError(
        operation,
        'Poyo returned a response larger than the local limit.'
      );
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!response.ok) return null;
    throw new PoyoError({
      category: 'malformed_response',
      technicalCode: 'invalid_json',
      message: 'Poyo returned invalid JSON.',
      retryable: false,
      operation,
      cause: error
    });
  }
}

export class PoyoTransport {
  private readonly fetchImplementation: PoyoFetch;
  private readonly clock: Clock;
  private readonly sleeper: Sleeper;
  private readonly random: () => number;
  private readonly logger: PoyoMetadataLogger;
  private readonly retryPolicy: RetryPolicy;
  private readonly defaultTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly baseUrl: string;

  constructor(private readonly options: PoyoTransportOptions) {
    if (!options.apiKey.trim()) throw new Error('PoyoTransport requires an API key.');
    this.fetchImplementation = options.fetch ?? fetch;
    this.clock = options.clock ?? systemClock;
    this.sleeper = options.sleeper ?? systemSleeper;
    this.random = options.random ?? Math.random;
    this.logger = options.logger ?? noopLogger;
    this.retryPolicy = options.retryPolicy ?? defaultRetryPolicy;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
    const configuredBaseUrl = new URL(options.baseUrl ?? POYO_API_BASE_URL);
    const isProduction = configuredBaseUrl.origin === POYO_API_BASE_URL;
    const isLoopback =
      ['127.0.0.1', '::1', 'localhost'].includes(configuredBaseUrl.hostname) &&
      configuredBaseUrl.protocol === 'http:';
    if (!isProduction && !isLoopback) {
      throw new Error('Poyo transport overrides are restricted to loopback test servers.');
    }
    this.baseUrl = configuredBaseUrl.origin;
  }

  async request(request: TransportRequest): Promise<unknown> {
    if (!request.path.startsWith('/api/') || request.path.includes('://')) {
      throw new Error('Poyo transport paths must remain under /api/.');
    }
    for (let attempt = 1; attempt <= this.retryPolicy.maxAttempts; attempt += 1) {
      const startedAt = this.clock.now();
      const bodyKind = request.bodyKind ?? (request.body ? 'json' : 'none');
      const baseMetadata: PoyoRequestMetadata = {
        operation: request.operation,
        method: request.method,
        path: request.path,
        attempt,
        bodyKind
      };
      await safelyLog(() => this.logger.requestStarted(baseMetadata));

      const controller = new AbortController();
      let timedOut = false;
      const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort(new DOMException('Poyo request timed out.', 'TimeoutError'));
      }, timeoutMs);
      const externalAbort = () => controller.abort(request.signal?.reason);
      if (request.signal?.aborted) externalAbort();
      else request.signal?.addEventListener('abort', externalAbort, { once: true });

      try {
        await this.options.beforeRequest?.(request.operation);
        await request.beforeDispatch?.();
        const headers = new Headers({
          Accept: 'application/json',
          Authorization: `Bearer ${this.options.apiKey}`
        });
        if (request.contentType) headers.set('Content-Type', request.contentType);
        const init: RequestInit = {
          method: request.method,
          headers,
          signal: controller.signal,
          redirect: 'manual',
          ...(request.body === undefined ? {} : { body: request.body })
        };
        const response = await this.fetchImplementation(`${this.baseUrl}${request.path}`, init);
        const payload = await readBoundedJson(response, request.operation, this.maxResponseBytes);
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), this.clock.now());
        if (!response.ok) {
          throw normalizePoyoError(request.operation, response.status, payload, retryAfterMs);
        }
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
          const code = (payload as { code?: unknown }).code;
          if (typeof code === 'number' && code !== 200) {
            throw normalizePoyoError(request.operation, code, payload, retryAfterMs);
          }
        }
        await safelyLog(() =>
          this.logger.requestFinished({
            ...baseMetadata,
            elapsedMs: Math.max(0, this.clock.now() - startedAt),
            status: response.status
          })
        );
        return payload;
      } catch (cause) {
        const error =
          cause instanceof PoyoError ? cause : networkError(request.operation, cause, timedOut);
        await safelyLog(() =>
          this.logger.requestFailed(
            { ...baseMetadata, elapsedMs: Math.max(0, this.clock.now() - startedAt) },
            error
          )
        );
        const canRetry =
          request.safeToRetry &&
          error.retryable &&
          attempt < this.retryPolicy.maxAttempts &&
          !request.signal?.aborted;
        if (!canRetry) throw error;
        await this.sleeper.sleep(
          retryDelay(attempt, this.retryPolicy, this.random, error.retryAfterMs),
          request.signal
        );
      } finally {
        clearTimeout(timeout);
        request.signal?.removeEventListener('abort', externalAbort);
      }
    }
    throw new Error('Poyo retry loop ended unexpectedly.');
  }
}
