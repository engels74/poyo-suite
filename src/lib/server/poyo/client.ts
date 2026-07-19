import { PoyoError } from './errors';
import {
  parseBalanceResponse,
  parseStatusResponse,
  parseSubmitResponse,
  parseUploadResponse
} from './parsers';
import type { PoyoTransport } from './transport';
import type {
  Clock,
  PoyoBalanceResult,
  PoyoRequestOptions,
  PoyoStatusResult,
  PoyoSubmitRequest,
  PoyoSubmitResult,
  PoyoUploadResult,
  UploadSource
} from './types';
import {
  buildBase64UploadBody,
  buildStreamUploadBody,
  buildUrlUploadBody,
  selectUploadMethod
} from './uploads';

function requestValidation(message: string): PoyoError {
  return new PoyoError({
    category: 'unsupported_configuration',
    technicalCode: 'local_request_validation',
    message,
    retryable: false,
    operation: 'submit'
  });
}

function validateCallbackUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw requestValidation('The callback URL is invalid.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    value.length > 2048
  ) {
    throw requestValidation(
      'The callback URL must be an HTTP(S) URL without embedded credentials.'
    );
  }
}

function jsonBody(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (cause) {
    throw new PoyoError({
      category: 'unsupported_configuration',
      technicalCode: 'non_serializable_request',
      message: 'The Poyo request contains values that cannot be serialized.',
      retryable: false,
      operation: 'submit',
      cause
    });
  }
}

function requestOptions(
  options: PoyoRequestOptions
): Pick<PoyoRequestOptions, 'signal' | 'timeoutMs' | 'beforeDispatch'> {
  return {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.beforeDispatch ? { beforeDispatch: options.beforeDispatch } : {})
  };
}

export class PoyoClient {
  constructor(
    private readonly transport: PoyoTransport,
    private readonly clock: Clock
  ) {}

  async getBalance(options: PoyoRequestOptions = {}): Promise<PoyoBalanceResult> {
    const payload = await this.transport.request({
      operation: 'balance',
      method: 'GET',
      path: '/api/user/balance',
      safeToRetry: true,
      ...requestOptions(options)
    });
    return parseBalanceResponse(payload, new Date(this.clock.now()));
  }

  async submit(
    request: PoyoSubmitRequest,
    options: PoyoRequestOptions = {}
  ): Promise<PoyoSubmitResult> {
    const model = request.model.trim();
    if (!model || model.length > 256) throw requestValidation('A valid Poyo model ID is required.');
    if (!request.input || typeof request.input !== 'object' || Array.isArray(request.input)) {
      throw requestValidation('Poyo generation input must be an object.');
    }
    if (request.callbackUrl) validateCallbackUrl(request.callbackUrl);
    const body = {
      model,
      ...(request.callbackUrl ? { callback_url: request.callbackUrl } : {}),
      input: request.input
    };
    const payload = await this.transport.request({
      operation: 'submit',
      method: 'POST',
      path: '/api/generate/submit',
      body: jsonBody(body),
      bodyKind: 'json',
      contentType: 'application/json',
      safeToRetry: false,
      ...requestOptions(options)
    });
    return parseSubmitResponse(payload);
  }

  async getStatus(taskId: string, options: PoyoRequestOptions = {}): Promise<PoyoStatusResult> {
    const id = taskId.trim();
    if (!id || id.length > 512) {
      throw new PoyoError({
        category: 'task',
        technicalCode: 'invalid_task_id',
        message: 'A valid Poyo task ID is required.',
        retryable: false,
        operation: 'status'
      });
    }
    const payload = await this.transport.request({
      operation: 'status',
      method: 'GET',
      path: `/api/generate/status/${encodeURIComponent(id)}`,
      safeToRetry: true,
      ...requestOptions(options)
    });
    return parseStatusResponse(payload);
  }

  async upload(source: UploadSource, options: PoyoRequestOptions = {}): Promise<PoyoUploadResult> {
    const method = selectUploadMethod(source);
    if (method === 'url' && source.kind === 'remote-url') {
      const payload = await this.transport.request({
        operation: 'upload_url',
        method: 'POST',
        path: '/api/common/upload/url',
        body: jsonBody(buildUrlUploadBody(source)),
        bodyKind: 'json',
        contentType: 'application/json',
        safeToRetry: false,
        ...requestOptions(options)
      });
      return parseUploadResponse(payload, 'upload_url');
    }
    if (method === 'base64' && source.kind === 'base64') {
      const payload = await this.transport.request({
        operation: 'upload_base64',
        method: 'POST',
        path: '/api/common/upload/base64',
        body: jsonBody(buildBase64UploadBody(source)),
        bodyKind: 'json',
        contentType: 'application/json',
        safeToRetry: false,
        ...requestOptions(options)
      });
      return parseUploadResponse(payload, 'upload_base64');
    }
    if (method === 'stream' && source.kind === 'local-file') {
      const payload = await this.transport.request({
        operation: 'upload_stream',
        method: 'POST',
        path: '/api/common/upload/stream',
        body: buildStreamUploadBody(source),
        bodyKind: 'multipart',
        safeToRetry: false,
        ...requestOptions(options)
      });
      return parseUploadResponse(payload, 'upload_stream');
    }
    throw new Error('Upload method and source did not match.');
  }
}
