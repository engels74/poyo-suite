import { runtimePoyoBaseUrl } from '../poyo/factory';
import {
  DEFAULT_OPERATIONS_SETTINGS,
  normalizeOperationsSettings,
  type OperationsSettings
} from '../settings/operations-settings';
import type { OutputDownloaderOptions } from './downloader';

export const TEST_MEDIA_ORIGIN = 'https://media.poyo-fixture.example';

export function runtimeTestDownloadTransport(
  environment: Record<string, string | undefined>
): Pick<OutputDownloaderOptions, 'fetch' | 'resolveHost'> | Record<never, never> {
  const proxyOrigin = runtimePoyoBaseUrl(environment);
  if (!proxyOrigin) return {};
  const expected = new URL(TEST_MEDIA_ORIGIN);
  return {
    resolveHost: async (hostname) => {
      if (hostname !== expected.hostname) {
        throw new Error('The test download resolver only accepts the fixture media host.');
      }
      return [{ address: '93.184.216.34', family: 4 }];
    },
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.origin !== expected.origin || url.username || url.password) {
        throw new Error('The test download transport only accepts the fixture media origin.');
      }
      const proxy = new URL(`${url.pathname}${url.search}`, proxyOrigin);
      return fetch(proxy, { method: 'GET', redirect: 'manual' });
    }
  };
}

export function runtimeJobTimings(environment: Record<string, string | undefined>): {
  pollDelayMs?: number;
  workerIntervalMs?: number;
} {
  const configured =
    environment.PLS_TEST_JOB_POLL_MS !== undefined ||
    environment.PLS_TEST_JOB_WORKER_MS !== undefined;
  if (!configured) return {};
  if (environment.PLS_TEST_MODE !== '1') {
    throw new Error('Test job timings are available only when PLS_TEST_MODE=1.');
  }
  const parse = (value: string | undefined, name: string): number | undefined => {
    if (value === undefined) return undefined;
    const milliseconds = Number(value);
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 25 || milliseconds > 10_000) {
      throw new Error(`${name} must be an integer between 25 and 10000 milliseconds.`);
    }
    return milliseconds;
  };
  const pollDelayMs = parse(environment.PLS_TEST_JOB_POLL_MS, 'PLS_TEST_JOB_POLL_MS');
  const workerIntervalMs = parse(environment.PLS_TEST_JOB_WORKER_MS, 'PLS_TEST_JOB_WORKER_MS');
  return {
    ...(pollDelayMs === undefined ? {} : { pollDelayMs }),
    ...(workerIntervalMs === undefined ? {} : { workerIntervalMs })
  };
}

export function runtimeJobCreateDelay(environment: Record<string, string | undefined>): number {
  const value = environment.PLS_TEST_JOB_CREATE_MS;
  if (value === undefined) return 0;
  if (environment.PLS_TEST_MODE !== '1') {
    throw new Error('Test job creation delay is available only when PLS_TEST_MODE=1.');
  }
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 25 || milliseconds > 5_000) {
    throw new Error('PLS_TEST_JOB_CREATE_MS must be an integer between 25 and 5000 milliseconds.');
  }
  return milliseconds;
}

export function runtimeOperationsSettings(value: unknown): OperationsSettings {
  if (value === undefined) return DEFAULT_OPERATIONS_SETTINGS;
  try {
    return normalizeOperationsSettings(value);
  } catch {
    return DEFAULT_OPERATIONS_SETTINGS;
  }
}
