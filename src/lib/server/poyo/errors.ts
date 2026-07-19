import { redactString } from '../diagnostics/redaction';
import type { PoyoOperation } from './types';

export type PoyoErrorCategory =
  | 'policy'
  | 'authentication'
  | 'insufficient_credits'
  | 'rate_limit'
  | 'unsupported_configuration'
  | 'upload'
  | 'submission'
  | 'task'
  | 'provider'
  | 'polling'
  | 'network'
  | 'malformed_response'
  | 'unknown';

export interface PoyoSafeErrorDto {
  category: PoyoErrorCategory;
  technicalCode: string;
  message: string;
  retryable: boolean;
  httpStatus: number | null;
  operation: PoyoOperation;
  upstreamType: string | null;
}

export interface PoyoErrorOptions {
  category: PoyoErrorCategory;
  technicalCode: string;
  message: string;
  retryable: boolean;
  operation: PoyoOperation;
  httpStatus?: number | null;
  upstreamType?: string | null;
  retryAfterMs?: number | null;
  cause?: unknown;
}

export class PoyoError extends Error {
  readonly category: PoyoErrorCategory;
  readonly technicalCode: string;
  readonly retryable: boolean;
  readonly operation: PoyoOperation;
  readonly httpStatus: number | null;
  readonly upstreamType: string | null;
  readonly retryAfterMs: number | null;

  constructor(options: PoyoErrorOptions) {
    super(redactString(options.message), { cause: options.cause });
    this.name = 'PoyoError';
    this.category = options.category;
    this.technicalCode = options.technicalCode;
    this.retryable = options.retryable;
    this.operation = options.operation;
    this.httpStatus = options.httpStatus ?? null;
    this.upstreamType = options.upstreamType ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }

  toSafeDto(): PoyoSafeErrorDto {
    return {
      category: this.category,
      technicalCode: this.technicalCode,
      message: this.message,
      retryable: this.retryable,
      httpStatus: this.httpStatus,
      operation: this.operation,
      upstreamType: this.upstreamType
    };
  }
}

export type PublicIpv4GuardReason = 'match' | 'unavailable' | 'misconfigured';

export function publicIpv4GuardReason(code: unknown): PublicIpv4GuardReason | null {
  if (code === 'public_ipv4_guard_match') return 'match';
  if (code === 'public_ipv4_guard_unavailable') return 'unavailable';
  if (code === 'public_ipv4_guard_misconfigured') return 'misconfigured';
  return null;
}

export function publicIpv4GuardError(
  operation: PoyoOperation,
  reason: PublicIpv4GuardReason
): PoyoError {
  return new PoyoError({
    category: 'policy',
    technicalCode:
      reason === 'match'
        ? 'public_ipv4_guard_match'
        : reason === 'unavailable'
          ? 'public_ipv4_guard_unavailable'
          : 'public_ipv4_guard_misconfigured',
    message:
      reason === 'match'
        ? 'Poyo was not contacted because the public IPv4 guard matched. Change networks or update the guard in Settings.'
        : reason === 'unavailable'
          ? 'Poyo was not contacted because the server could not verify its public IPv4. Refresh IP status or review Settings.'
          : 'Poyo was not contacted because the saved public IPv4 guard settings are invalid. Disable or correct the guard in Settings.',
    retryable: false,
    operation
  });
}

interface UpstreamErrorEnvelope {
  code?: unknown;
  error?: {
    message?: unknown;
    type?: unknown;
  };
  detail?: unknown;
}

function detailMessage(detail: unknown): string | null {
  if (typeof detail === 'string') return detail;
  if (!Array.isArray(detail)) return null;
  const messages = detail
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      return typeof (entry as { msg?: unknown }).msg === 'string'
        ? (entry as { msg: string }).msg
        : null;
    })
    .filter((message): message is string => Boolean(message));
  return messages.length > 0 ? messages.join('; ') : null;
}

function defaultCategory(operation: PoyoOperation): PoyoErrorCategory {
  if (operation.startsWith('upload_')) return 'upload';
  if (operation === 'submit') return 'submission';
  if (operation === 'status') return 'polling';
  return 'unknown';
}

export function normalizePoyoError(
  operation: PoyoOperation,
  httpStatus: number,
  payload: unknown,
  retryAfterMs: number | null = null
): PoyoError {
  const envelope =
    payload && typeof payload === 'object' ? (payload as UpstreamErrorEnvelope) : undefined;
  const upstreamType = typeof envelope?.error?.type === 'string' ? envelope.error.type : null;
  const upstreamMessage =
    typeof envelope?.error?.message === 'string'
      ? envelope.error.message
      : detailMessage(envelope?.detail);
  const businessCode = typeof envelope?.code === 'number' ? envelope.code : httpStatus;
  const status = businessCode >= 400 ? businessCode : httpStatus;
  const type = upstreamType?.toLowerCase() ?? '';

  if (status === 401 || status === 403 || type.includes('authentication')) {
    return new PoyoError({
      category: 'authentication',
      technicalCode: upstreamType ?? `http_${status}`,
      message: 'Poyo authentication failed. Check the configured API key.',
      retryable: false,
      operation,
      httpStatus: status,
      upstreamType
    });
  }
  if (status === 402 || type.includes('insufficient_credits')) {
    return new PoyoError({
      category: 'insufficient_credits',
      technicalCode: upstreamType ?? 'insufficient_credits',
      message: 'The Poyo account does not have enough credits for this request.',
      retryable: false,
      operation,
      httpStatus: status,
      upstreamType
    });
  }
  if (status === 429 || type.includes('rate_limit')) {
    return new PoyoError({
      category: 'rate_limit',
      technicalCode: upstreamType ?? 'rate_limited',
      message: 'Poyo rate-limited the request. It can be retried when safe.',
      retryable: true,
      operation,
      httpStatus: status,
      upstreamType,
      retryAfterMs
    });
  }
  if (status === 408 || type.includes('timeout')) {
    return new PoyoError({
      category: 'network',
      technicalCode: upstreamType ?? 'upstream_timeout',
      message: 'Poyo reported a request timeout. The remote generation state may still exist.',
      retryable: true,
      operation,
      httpStatus: status,
      upstreamType
    });
  }
  if (
    status === 400 ||
    status === 413 ||
    status === 422 ||
    type.includes('validation') ||
    type.includes('invalid_request') ||
    type.includes('content_') ||
    type.includes('file_format')
  ) {
    return new PoyoError({
      category: operation.startsWith('upload_') ? 'upload' : 'unsupported_configuration',
      technicalCode: upstreamType ?? `http_${status}`,
      message: upstreamMessage ?? 'Poyo rejected the request configuration.',
      retryable: false,
      operation,
      httpStatus: status,
      upstreamType
    });
  }
  if (status === 404 && operation === 'status') {
    return new PoyoError({
      category: 'task',
      technicalCode: upstreamType ?? 'task_not_found',
      message: 'The Poyo task could not be found.',
      retryable: false,
      operation,
      httpStatus: status,
      upstreamType
    });
  }
  if (status >= 500 || type.includes('upstream') || type.includes('service')) {
    return new PoyoError({
      category: 'provider',
      technicalCode: upstreamType ?? `http_${status}`,
      message: 'Poyo or its upstream provider is temporarily unavailable.',
      retryable: true,
      operation,
      httpStatus: status,
      upstreamType
    });
  }

  return new PoyoError({
    category: defaultCategory(operation),
    technicalCode: upstreamType ?? `http_${status}`,
    message: upstreamMessage ?? 'Poyo returned an unrecognized error.',
    retryable: false,
    operation,
    httpStatus: status,
    upstreamType
  });
}

export function malformedResponseError(operation: PoyoOperation, message: string): PoyoError {
  return new PoyoError({
    category: 'malformed_response',
    technicalCode: 'malformed_response',
    message,
    retryable: false,
    operation
  });
}

export function networkError(
  operation: PoyoOperation,
  cause: unknown,
  timeout: boolean
): PoyoError {
  return new PoyoError({
    category: 'network',
    technicalCode: timeout ? 'request_timeout' : 'network_failure',
    message: timeout
      ? 'The Poyo request timed out locally. The remote generation state is unchanged.'
      : 'The local server could not reach Poyo. The remote generation state is unchanged.',
    retryable: true,
    operation,
    cause
  });
}
