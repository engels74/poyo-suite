import { malformedResponseError } from './errors';
import type {
  PoyoBalanceResult,
  PoyoOperation,
  PoyoOutputFile,
  PoyoStatusResult,
  PoyoSubmitResult,
  PoyoTaskStatus,
  PoyoUploadResult
} from './types';

type RecordValue = Record<string, unknown>;

function record(value: unknown, operation: PoyoOperation, context: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw malformedResponseError(operation, `Poyo returned invalid ${context}.`);
  }
  return value as RecordValue;
}

function wrappedData(value: unknown, operation: PoyoOperation): RecordValue {
  const root = record(value, operation, 'JSON');
  if ('data' in root) return record(root.data, operation, 'response data');
  return root;
}

function requiredString(value: unknown, operation: PoyoOperation, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw malformedResponseError(operation, `Poyo omitted the required ${field} field.`);
  }
  return value;
}

function optionalString(value: unknown, operation: PoyoOperation, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw malformedResponseError(operation, `Poyo returned an invalid ${field} field.`);
  }
  return value;
}

function finiteNumber(value: unknown, operation: PoyoOperation, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw malformedResponseError(operation, `Poyo returned an invalid ${field} field.`);
  }
  return value;
}

function requiredHttpUrl(value: unknown, operation: PoyoOperation, field: string): string {
  const raw = requiredString(value, operation, field);
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' || url.protocol === 'https:') return raw;
  } catch {
    // Fall through to the normalized malformed response.
  }
  throw malformedResponseError(operation, `Poyo returned an invalid ${field} URL.`);
}

export function normalizeTaskStatus(status: string): PoyoTaskStatus {
  if (status === 'cancelled' || status === 'canceled') return 'failed';
  if (
    status === 'not_started' ||
    status === 'running' ||
    status === 'finished' ||
    status === 'failed'
  ) {
    return status;
  }
  return 'unknown';
}

export function parseSubmitResponse(payload: unknown): PoyoSubmitResult {
  const data = wrappedData(payload, 'submit');
  const statusRaw = requiredString(data.status, 'submit', 'status');
  return {
    taskId: requiredString(data.task_id, 'submit', 'task_id'),
    statusRaw,
    status: normalizeTaskStatus(statusRaw),
    createdTime: requiredString(data.created_time, 'submit', 'created_time')
  };
}

function parseOutputFile(value: unknown): PoyoOutputFile {
  const file = record(value, 'status', 'output file');
  const size = file.file_size;
  if (
    size !== null &&
    size !== undefined &&
    (typeof size !== 'number' || !Number.isFinite(size) || size < 0)
  ) {
    throw malformedResponseError('status', 'Poyo returned an invalid output file_size field.');
  }
  return {
    url: requiredHttpUrl(file.file_url, 'status', 'file_url'),
    fileType: requiredString(file.file_type, 'status', 'file_type'),
    label: optionalString(file.label, 'status', 'label'),
    format: optionalString(file.format, 'status', 'format'),
    contentType: optionalString(file.content_type, 'status', 'content_type'),
    fileName: optionalString(file.file_name, 'status', 'file_name'),
    fileSize: typeof size === 'number' ? size : null
  };
}

export function parseStatusResponse(payload: unknown): PoyoStatusResult {
  const data = wrappedData(payload, 'status');
  const statusRaw = requiredString(data.status, 'status', 'status');
  const progress = data.progress;
  if (
    progress !== null &&
    progress !== undefined &&
    (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 100)
  ) {
    throw malformedResponseError('status', 'Poyo returned progress outside the 0-100 range.');
  }
  const files = data.files ?? [];
  if (!Array.isArray(files)) {
    throw malformedResponseError('status', 'Poyo returned an invalid files field.');
  }
  const creditsAmount =
    data.credits_amount === null
      ? null
      : finiteNumber(data.credits_amount, 'status', 'credits_amount');
  if (creditsAmount !== null && creditsAmount < 0) {
    throw malformedResponseError('status', 'Poyo returned a negative credits_amount field.');
  }
  return {
    taskId: requiredString(data.task_id, 'status', 'task_id'),
    statusRaw,
    status: normalizeTaskStatus(statusRaw),
    creditsAmount,
    files: files.map(parseOutputFile),
    createdTime: requiredString(data.created_time, 'status', 'created_time'),
    progress: typeof progress === 'number' ? progress : null,
    errorMessage: optionalString(data.error_message, 'status', 'error_message')
  };
}

export function parseBalanceResponse(payload: unknown, fetchedAt: Date): PoyoBalanceResult {
  const data = wrappedData(payload, 'balance');
  return {
    email: requiredString(data.email, 'balance', 'email'),
    creditsAmount: finiteNumber(data.credits_amount, 'balance', 'credits_amount'),
    fetchedAt: fetchedAt.toISOString()
  };
}

export function parseUploadResponse(
  payload: unknown,
  operation: 'upload_url' | 'upload_base64' | 'upload_stream'
): PoyoUploadResult {
  const root = record(payload, operation, 'upload JSON');
  if ('success' in root && root.success !== true) {
    throw malformedResponseError(operation, 'Poyo returned an unsuccessful upload envelope.');
  }
  const data = wrappedData(payload, operation);
  const size = finiteNumber(data.file_size, operation, 'file_size');
  if (size < 0) throw malformedResponseError(operation, 'Poyo returned a negative file_size.');
  return {
    fileId: requiredString(data.file_id, operation, 'file_id'),
    fileName: requiredString(data.file_name, operation, 'file_name'),
    originalName: optionalString(data.original_name, operation, 'original_name'),
    fileSize: size,
    mimeType: requiredString(data.mime_type, operation, 'mime_type'),
    uploadPath: optionalString(data.upload_path, operation, 'upload_path'),
    fileUrl: requiredHttpUrl(data.file_url, operation, 'file_url'),
    downloadUrl: requiredHttpUrl(data.download_url, operation, 'download_url'),
    uploadTime: optionalString(data.upload_time, operation, 'upload_time'),
    expiresAt: requiredString(data.expires_at, operation, 'expires_at')
  };
}
