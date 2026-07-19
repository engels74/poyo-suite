import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { openDatabase } from '../../../src/lib/server/platform/database';
import { operationsHttpError } from '../../../src/lib/server/operations/http';
import {
  PUBLIC_IPV4_GUARD_SETTING_KEY,
  PUBLIC_IPV4_LOOKUP_TIMEOUT_MS,
  PUBLIC_IPV4_MAX_RESPONSE_BYTES,
  PublicIpv4Service,
  runtimePublicIpv4LookupUrl
} from '../../../src/lib/server/platform/public-ipv4';
import { PoyoTransport } from '../../../src/lib/server/poyo/transport';
import { SettingsRepository } from '../../../src/lib/server/settings/settings-repository';
import { createTemporaryDirectory } from '../../helpers/temporary-directory';

const cleanups: Array<() => Promise<void> | void> = [];
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function service(
  fetchImplementation: FetchLike,
  options: Partial<ConstructorParameters<typeof PublicIpv4Service>[0]> = {}
) {
  const temporary = await createTemporaryDirectory('public-ipv4-');
  const database = await openDatabase(join(temporary.path, 'studio.sqlite'));
  cleanups.push(() => temporary.cleanup());
  cleanups.push(() => database.close());
  const settings = new SettingsRepository(database);
  return {
    settings,
    value: new PublicIpv4Service({
      settings,
      fetch: fetchImplementation,
      lookupUrl: 'http://127.0.0.1/ip',
      ...options
    })
  };
}

describe('public IPv4 lookup and enforcement', () => {
  test('pins production lookup and restricts test overrides to exact loopback /ip', () => {
    expect(runtimePublicIpv4LookupUrl({})).toBe('https://api.ipify.org');
    expect(() =>
      runtimePublicIpv4LookupUrl({ PLS_TEST_PUBLIC_IPV4_URL: 'http://127.0.0.1/ip' })
    ).toThrow('PLS_TEST_MODE=1');
    for (const url of [
      'https://127.0.0.1/ip',
      'http://example.com/ip',
      'http://127.0.0.1/other',
      'http://user@127.0.0.1/ip',
      'http://127.0.0.1/ip?q=1'
    ]) {
      expect(() =>
        runtimePublicIpv4LookupUrl({
          PLS_TEST_MODE: '1',
          PLS_TEST_PUBLIC_IPV4_URL: url
        })
      ).toThrow();
    }
    expect(
      runtimePublicIpv4LookupUrl({
        PLS_TEST_MODE: '1',
        PLS_TEST_PUBLIC_IPV4_URL: 'http://127.0.0.1:4321/ip'
      })
    ).toBe('http://127.0.0.1:4321/ip');
    expect(PUBLIC_IPV4_LOOKUP_TIMEOUT_MS).toBe(2_000);
    expect(PUBLIC_IPV4_MAX_RESPONSE_BYTES).toBe(64);
  });

  test('sends a data-free bounded request and returns a validated public address', async () => {
    const seen: Array<{ input: string; init: RequestInit | undefined }> = [];
    const setup = await service(async (input, init) => {
      seen.push({ input: String(input), init });
      return new Response('8.8.4.4\n');
    });
    await expect(setup.value.status()).resolves.toMatchObject({
      currentIpv4: '8.8.4.4',
      state: 'guard-disabled'
    });
    expect(seen[0]?.input).toBe('http://127.0.0.1/ip');
    expect(seen[0]?.init?.method).toBe('GET');
    expect(seen[0]?.init?.body).toBeUndefined();
    expect(seen[0]?.init?.credentials).toBe('omit');
    expect(seen[0]?.init?.redirect).toBe('manual');
    expect(new Headers(seen[0]?.init?.headers).get('authorization')).toBeNull();
  });

  test.each([
    ['malformed', async () => new Response('not-an-ip')],
    ['private', async () => new Response('192.168.1.2')],
    ['streamed oversize', async () => new Response('x'.repeat(65))],
    ['empty', async () => new Response('')],
    ['redirect', async () => new Response(null, { status: 302 })],
    [
      'network failure',
      async () => {
        throw new TypeError('fixture reset');
      }
    ]
  ])('fails closed for %s responses', async (_name, implementation) => {
    const setup = await service(implementation as FetchLike);
    setup.value.saveSettings({ enabled: true, homeIpv4: '8.8.4.4' });
    await expect(setup.value.assertPoyoRequestAllowed('submit')).rejects.toMatchObject({
      category: 'policy',
      technicalCode: 'public_ipv4_guard_unavailable',
      retryable: false
    });
  });

  test('cancels the provider body before rejecting a declared oversized response', async () => {
    let cancelled = false;
    const setup = await service(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('8.8.4.4'));
            },
            cancel() {
              cancelled = true;
            }
          }),
          { headers: { 'content-length': '65' } }
        )
    );
    setup.value.saveSettings({ enabled: true, homeIpv4: '8.8.4.4' });
    await expect(setup.value.assertPoyoRequestAllowed('submit')).rejects.toMatchObject({
      technicalCode: 'public_ipv4_guard_unavailable'
    });
    expect(cancelled).toBe(true);
  });

  test('coalesces concurrent normal and forced observations into one lookup', async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const setup = await service(async () => {
      calls += 1;
      await gate;
      return new Response('8.8.4.4');
    });

    const normal = setup.value.status();
    while (calls === 0) await Bun.sleep(1);
    const forced = setup.value.status({ refresh: true });
    release?.();

    const [normalStatus, forcedStatus] = await Promise.all([normal, forced]);
    expect(calls).toBe(1);
    expect(normalStatus.currentIpv4).toBe('8.8.4.4');
    expect(forcedStatus.currentIpv4).toBe('8.8.4.4');
  });

  test('times out, caches conservatively, and never falls back to expired success', async () => {
    let now = 0;
    let calls = 0;
    const setup = await service(
      async (_input, init) => {
        calls += 1;
        if (calls === 1) return new Response('1.1.1.1');
        if (calls === 2) throw new TypeError('provider down');
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true
          });
        });
      },
      { now: () => now, timeoutMs: 5 }
    );
    setup.value.saveSettings({ enabled: true, homeIpv4: '8.8.4.4' });
    await expect(setup.value.assertPoyoRequestAllowed('submit')).resolves.toBeUndefined();
    await expect(setup.value.assertPoyoRequestAllowed('status')).resolves.toBeUndefined();
    expect(calls).toBe(1);
    now = 60_001;
    await expect(setup.value.assertPoyoRequestAllowed('submit')).rejects.toMatchObject({
      technicalCode: 'public_ipv4_guard_unavailable'
    });
    expect(calls).toBe(2);
    now = 70_002;
    await expect(setup.value.status({ refresh: true })).resolves.toMatchObject({
      state: 'unavailable',
      currentIpv4: null
    });
    expect(calls).toBe(3);
  });

  test('disabled skips lookup, matching blocks, and a different current address allows', async () => {
    let calls = 0;
    let current = '8.8.4.4';
    const setup = await service(async () => {
      calls += 1;
      return new Response(current);
    });
    await expect(setup.value.assertPoyoRequestAllowed('submit')).resolves.toBeUndefined();
    expect(calls).toBe(0);
    setup.value.saveSettings({ enabled: true, homeIpv4: '8.8.4.4' });
    await expect(setup.value.assertPoyoRequestAllowed('submit')).rejects.toMatchObject({
      technicalCode: 'public_ipv4_guard_match'
    });
    expect(calls).toBe(1);
    current = '1.1.1.1';
    await setup.value.status({ refresh: true });
    await expect(setup.value.assertPoyoRequestAllowed('submit')).resolves.toBeUndefined();
  });

  test('a corrupt persisted enabled row is address-free, lookup-free, and upstream-closed', async () => {
    let lookups = 0;
    let upstreamCalls = 0;
    const setup = await service(async () => {
      lookups += 1;
      return new Response('1.1.1.1');
    });
    setup.settings.set(PUBLIC_IPV4_GUARD_SETTING_KEY, {
      enabled: true,
      homeIpv4: '192.168.27.9'
    });
    expect(setup.value.readSettings()).toEqual({ enabled: true, homeIpv4: null });
    await expect(setup.value.status()).resolves.toEqual({
      state: 'misconfigured',
      currentIpv4: null,
      checkedAt: null,
      availability: 'unavailable'
    });

    const transport = new PoyoTransport({
      apiKey: ['sk', 'misconfigured_guard_123456'].join('-'),
      beforeRequest: (operation) => setup.value.assertPoyoRequestAllowed(operation),
      fetch: async () => {
        upstreamCalls += 1;
        return Response.json({ code: 200, data: {} });
      }
    });
    let failure: unknown;
    try {
      await transport.request({
        operation: 'submit',
        method: 'POST',
        path: '/api/generate/submit',
        safeToRetry: false
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      category: 'policy',
      technicalCode: 'public_ipv4_guard_misconfigured',
      retryable: false
    });
    expect(String(failure)).not.toContain('192.168.27.9');
    expect({ lookups, upstreamCalls }).toEqual({ lookups: 0, upstreamCalls: 0 });
  });

  test('a malformed persisted disabled row tolerantly falls back to the disabled default', async () => {
    let lookups = 0;
    const setup = await service(async () => {
      lookups += 1;
      return new Response('8.8.4.4');
    });
    setup.settings.set(PUBLIC_IPV4_GUARD_SETTING_KEY, {
      enabled: false,
      homeIpv4: '192.168.27.9'
    });
    expect(setup.value.readSettings()).toEqual({ enabled: false, homeIpv4: null });
    await expect(setup.value.assertPoyoRequestAllowed('submit')).resolves.toBeUndefined();
    expect(lookups).toBe(0);
  });

  test('strict save errors map to HTTP 400 and never replace persisted settings', async () => {
    const setup = await service(async () => new Response('8.8.4.4'));
    const persisted = setup.value.saveSettings({ enabled: true, homeIpv4: '8.8.4.4' });
    for (const value of [
      null,
      [],
      'disabled',
      {},
      { enabled: false },
      { homeIpv4: null },
      { enabled: false, homeIpv4: null, unknown: true },
      { enabled: 'false', homeIpv4: null },
      { enabled: false, homeIpv4: '' }
    ]) {
      let failure: unknown;
      try {
        setup.value.saveSettings(value);
      } catch (error) {
        failure = error;
      }
      const response = operationsHttpError(failure);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: 'public_ipv4_guard_invalid' }
      });
      expect(setup.settings.get(PUBLIC_IPV4_GUARD_SETTING_KEY)?.value).toEqual(persisted);
    }
  });
});
