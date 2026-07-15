import type { ApiKeyManager } from '../settings/api-key-manager';
import type { StructuredLogger } from '../diagnostics/jsonl-logger';
import { systemClock } from './backoff';
import { PoyoClient } from './client';
import { PoyoError } from './errors';
import { createPoyoMetadataLogger } from './logging';
import { PoyoTransport, type PoyoTransportOptions } from './transport';
import type { Clock } from './types';

export interface PoyoClientFactoryOptions
  extends Omit<PoyoTransportOptions, 'apiKey' | 'clock' | 'logger'> {
  apiKeyManager: Pick<ApiKeyManager, 'resolve'>;
  logger?: StructuredLogger;
  clock?: Clock;
  environment?: Record<string, string | undefined>;
}

export function runtimePoyoBaseUrl(
  environment: Record<string, string | undefined>
): string | undefined {
  const configured = environment.PLS_TEST_POYO_BASE_URL?.trim();
  if (!configured) return undefined;
  if (environment.PLS_TEST_MODE !== '1') {
    throw new Error('PLS_TEST_POYO_BASE_URL is available only when PLS_TEST_MODE=1.');
  }

  const url = new URL(configured);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '::1', 'localhost'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('The test Poyo origin must be an origin-only loopback HTTP URL.');
  }
  return url.origin;
}

export async function createPoyoClient(options: PoyoClientFactoryOptions): Promise<PoyoClient> {
  const resolved = await options.apiKeyManager.resolve();
  if (!resolved.key) {
    throw new PoyoError({
      category: 'authentication',
      technicalCode: 'api_key_missing',
      message: 'Configure a Poyo API key before connecting.',
      retryable: false,
      operation: 'configuration'
    });
  }
  const clock = options.clock ?? systemClock;
  const baseUrl = options.baseUrl ?? runtimePoyoBaseUrl(options.environment ?? {});
  const transport = new PoyoTransport({
    apiKey: resolved.key,
    clock,
    ...(baseUrl ? { baseUrl } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.sleeper ? { sleeper: options.sleeper } : {}),
    ...(options.random ? { random: options.random } : {}),
    ...(options.retryPolicy ? { retryPolicy: options.retryPolicy } : {}),
    ...(options.defaultTimeoutMs === undefined
      ? {}
      : { defaultTimeoutMs: options.defaultTimeoutMs }),
    ...(options.maxResponseBytes === undefined
      ? {}
      : { maxResponseBytes: options.maxResponseBytes }),
    ...(options.logger ? { logger: createPoyoMetadataLogger(options.logger) } : {})
  });
  return new PoyoClient(transport, clock);
}
