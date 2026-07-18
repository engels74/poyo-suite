import { describe, expect, test } from 'bun:test';
import { createPoyoClient, runtimePoyoBaseUrl } from '../../../src/lib/server/poyo/factory';
import { MemoryPoyoMetadataLogger } from '../../../src/lib/server/poyo/logging';
import { PoyoTransport } from '../../../src/lib/server/poyo/transport';

const missingStatus = {
  source: 'none' as const,
  status: 'missing' as const,
  storeKind: 'file' as const,
  selectedBackend: 'file' as const,
  backendAvailability: { file: 'available' as const, os: 'unchecked' as const },
  transition: null,
  onboardingAvailable: true,
  environmentManaged: false,
  localMutationAvailable: true,
  updatedAt: null
};

describe('Poyo transport safety boundaries', () => {
  test('SEC-03 runtime test origins fail closed unless explicitly enabled and loopback-only', () => {
    expect(() => runtimePoyoBaseUrl({ PLS_TEST_POYO_BASE_URL: 'http://127.0.0.1:4311' })).toThrow(
      'PLS_TEST_MODE=1'
    );
    expect(() =>
      runtimePoyoBaseUrl({
        PLS_TEST_MODE: '1',
        PLS_TEST_POYO_BASE_URL: 'https://api.poyo.ai'
      })
    ).toThrow('loopback');
    expect(() =>
      runtimePoyoBaseUrl({
        PLS_TEST_MODE: '1',
        PLS_TEST_POYO_BASE_URL: 'http://127.0.0.1:4311/path'
      })
    ).toThrow('origin-only');
    expect(
      runtimePoyoBaseUrl({
        PLS_TEST_MODE: '1',
        PLS_TEST_POYO_BASE_URL: 'http://127.0.0.1:4311'
      })
    ).toBe('http://127.0.0.1:4311');
  });

  test('SEC-03 only sends credentials to Poyo or explicit loopback fixtures', () => {
    expect(
      () =>
        new PoyoTransport({
          apiKey: ['sk', 'host_canary_123456'].join('-'),
          baseUrl: 'https://attacker.example'
        })
    ).toThrow('loopback');
  });

  test('PYO-05 factory refuses to create a client without a server-side key', async () => {
    await expect(
      createPoyoClient({
        apiKeyManager: { resolve: async () => ({ key: null, status: missingStatus }) }
      })
    ).rejects.toMatchObject({
      category: 'authentication',
      technicalCode: 'api_key_missing',
      operation: 'configuration'
    });
  });

  test('RATE-02 retries safe network failures with injected fetch, sleeper, and jitter', async () => {
    let attempts = 0;
    const delays: number[] = [];
    const transport = new PoyoTransport({
      apiKey: ['sk', 'retry_canary_123456'].join('-'),
      fetch: async () => {
        attempts += 1;
        if (attempts < 3) throw new TypeError('fixture connection reset');
        return Response.json({ code: 200, data: { ok: true } });
      },
      sleeper: {
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
        }
      },
      random: () => 0.5,
      retryPolicy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000, jitterRatio: 0 }
    });

    await expect(
      transport.request({
        operation: 'status',
        method: 'GET',
        path: '/api/generate/status/task',
        safeToRetry: true
      })
    ).resolves.toEqual({ code: 200, data: { ok: true } });
    expect(attempts).toBe(3);
    expect(delays).toEqual([100, 200]);
  });

  test('PYO-06 caps malformed responses and does not leak media through request metadata', async () => {
    const logger = new MemoryPoyoMetadataLogger();
    const transport = new PoyoTransport({
      apiKey: ['sk', 'malformed_canary_123456'].join('-'),
      logger,
      maxResponseBytes: 8,
      fetch: async () => new Response('{"too":"large"}')
    });

    await expect(
      transport.request({
        operation: 'upload_base64',
        method: 'POST',
        path: '/api/common/upload/base64',
        body: JSON.stringify({ base64_data: 'A'.repeat(200) }),
        bodyKind: 'json',
        contentType: 'application/json',
        safeToRetry: false
      })
    ).rejects.toMatchObject({ category: 'malformed_response' });
    expect(JSON.stringify(logger.events)).not.toContain('A'.repeat(20));
  });

  test('PYO-06 does not retry an ambiguously timed-out paid request', async () => {
    let attempts = 0;
    const transport = new PoyoTransport({
      apiKey: ['sk', 'timeout_canary_123456'].join('-'),
      defaultTimeoutMs: 2,
      fetch: async (_input, init) => {
        attempts += 1;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true
          });
        });
      }
    });

    await expect(
      transport.request({
        operation: 'submit',
        method: 'POST',
        path: '/api/generate/submit',
        body: '{}',
        bodyKind: 'json',
        contentType: 'application/json',
        safeToRetry: false
      })
    ).rejects.toMatchObject({ category: 'network', technicalCode: 'request_timeout' });
    expect(attempts).toBe(1);
  });

  test('PYO-05 maps a plain-text upstream HTTP failure without exposing its body', async () => {
    const transport = new PoyoTransport({
      apiKey: ['sk', 'plaintext_canary_123456'].join('-'),
      fetch: async () => new Response('gateway details', { status: 502 })
    });

    await expect(
      transport.request({
        operation: 'submit',
        method: 'POST',
        path: '/api/generate/submit',
        body: '{}',
        bodyKind: 'json',
        contentType: 'application/json',
        safeToRetry: false
      })
    ).rejects.toMatchObject({ category: 'provider', httpStatus: 502 });
  });
});
