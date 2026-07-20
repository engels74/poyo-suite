import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UnsupportedPricingRow } from '../../../src/lib/features/pricing/inventory';
import { openDatabase } from '../../../src/lib/server/platform/database';
import { MaintenanceGate } from '../../../src/lib/server/platform/maintenance-gate';
import {
  type PricingRefreshFailureCategory,
  PUBLIC_PRICING_BACKOFF_BASE_MS,
  PUBLIC_PRICING_MAX_RESPONSE_BYTES,
  PUBLIC_PRICING_SETTING_KEY,
  PUBLIC_PRICING_TTL_MS,
  PUBLIC_PRICING_URL,
  PUBLIC_PRICING_USER_AGENT,
  PublicPricingService,
  parsePublicPricingHtml
} from '../../../src/lib/server/pricing/public-pricing';
import { SettingsRepository } from '../../../src/lib/server/settings/settings-repository';
import { createTemporaryDirectory } from '../../helpers/temporary-directory';

interface PublicPricingCorpusReview {
  version: string;
  source: {
    url: string;
    verifiedAt: string;
    contentSha256: string;
  };
  normalizedInventorySha256: string;
  publicRowCount: number;
  supportedTierCount: number;
  unsupportedRowCount: number;
  inconsistentUsdRows: number;
}

const reviewed = JSON.parse(
  readFileSync(join(import.meta.dir, '../../fixtures/pricing/reviewed-inventory.json'), 'utf8')
) as PublicPricingCorpusReview;
const fixtureHtml = readFileSync(
  join(import.meta.dir, '../../fixtures/pricing/public-pricing.html'),
  'utf8'
);
const supported = JSON.parse(
  readFileSync(join(import.meta.dir, '../../fixtures/pricing/supported-signatures.json'), 'utf8')
) as Array<{ tierSignature: string }>;
const unsupported = JSON.parse(
  readFileSync(join(import.meta.dir, '../../fixtures/pricing/unsupported-rows.json'), 'utf8')
) as UnsupportedPricingRow[];

const cleanups: Array<() => Promise<void> | void> = [];
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function validResponse(headers?: HeadersInit): Response {
  return new Response(fixtureHtml, { status: 200, ...(headers ? { headers } : {}) });
}

function nextChunk(value: string): string {
  return `<script>self.__next_f.push(${JSON.stringify([1, value])})</script>`;
}

function modelsHtml(models: unknown): string {
  return nextChunk(`5:{"models":${JSON.stringify(models)}}`);
}

function hostileModelsHtml(): string {
  return nextChunk(`5:{${'"models":['.repeat(50_000)}`);
}

function sha256(value: string): string {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex');
}

async function setup(
  fetchImplementation: FetchLike,
  options: {
    now?: () => number;
    timeoutMs?: number;
    maxResponseBytes?: number;
    gate?: MaintenanceGate;
    reportFailure?: (category: PricingRefreshFailureCategory) => Promise<void> | void;
  } = {}
) {
  const temporary = await createTemporaryDirectory('public-pricing-');
  const database = await openDatabase(join(temporary.path, 'studio.sqlite'));
  cleanups.push(() => temporary.cleanup());
  cleanups.push(() => database.close());
  const settings = new SettingsRepository(database);
  const gate = options.gate ?? new MaintenanceGate();
  const service = new PublicPricingService({
    settings,
    gate,
    fetch: fetchImplementation,
    ...(options.now ? { now: options.now } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxResponseBytes === undefined
      ? {}
      : { maxResponseBytes: options.maxResponseBytes }),
    ...(options.reportFailure ? { reportFailure: options.reportFailure } : {})
  });
  return { database, gate, service, settings };
}

function stored(settings: SettingsRepository): Record<string, unknown> | null {
  return settings.get<Record<string, unknown>>(PUBLIC_PRICING_SETTING_KEY)?.value ?? null;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error('Condition did not settle.');
}

async function expectPending(promise: Promise<unknown>): Promise<void> {
  const outcome = await Promise.race([
    promise.then(
      () => 'settled',
      () => 'settled'
    ),
    Bun.sleep(10).then(() => 'pending')
  ]);
  expect(outcome).toBe('pending');
}

describe('fixed public pricing fixture parser', () => {
  test('accounts for every public image/video row and retains only reviewed tiers', () => {
    const inventory = parsePublicPricingHtml(fixtureHtml);
    const normalizedInventory = JSON.stringify({
      tiers: inventory.tiers,
      unsupported: inventory.unsupported,
      publicRowCount: inventory.publicRowCount,
      inconsistentUsdRows: inventory.inconsistentUsdRows
    });
    expect(reviewed).toMatchObject({
      version: 'poyo-public-pricing-2026-07-20.1',
      source: { url: PUBLIC_PRICING_URL },
      publicRowCount: 209,
      supportedTierCount: 76,
      unsupportedRowCount: 133,
      inconsistentUsdRows: 0
    });
    expect(reviewed.source.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Number.isFinite(Date.parse(reviewed.source.verifiedAt))).toBe(true);
    expect(inventory.publicRowCount).toBe(reviewed.publicRowCount);
    expect(inventory.tiers).toHaveLength(reviewed.supportedTierCount);
    expect(inventory.unsupported).toHaveLength(reviewed.unsupportedRowCount);
    expect(sha256(normalizedInventory)).toBe(reviewed.normalizedInventorySha256);
    expect(inventory.tiers.map((tier) => tier.signature).sort()).toEqual(
      supported.map((fixture) => fixture.tierSignature).sort()
    );
    expect(inventory.unsupported).toEqual(unsupported);
    expect(inventory.inconsistentUsdRows).toBe(reviewed.inconsistentUsdRows);
  });

  test('joins JSON-compatible Next chunks and never executes JavaScript', () => {
    const models = [
      {
        category: 'Image',
        pricingTiers: [{ model: 'seedream-5.0-pro', credits: 8, priceUSD: 0.04, unit: 'per image' }]
      }
    ];
    const encoded = JSON.stringify(models);
    const split = Math.floor(encoded.length / 2);
    const joined = `${nextChunk('5:{"models":')}${nextChunk(encoded.slice(0, split))}${nextChunk(
      `${encoded.slice(split)}}`
    )}`;
    expect(parsePublicPricingHtml(joined).tiers).toHaveLength(1);

    (globalThis as { pricingParserExecuted?: boolean }).pricingParserExecuted = false;
    const malicious = `<script>self.__next_f.push((globalThis.pricingParserExecuted=true,[1,"x"]))</script>`;
    expect(() => parsePublicPricingHtml(malicious)).toThrow();
    expect((globalThis as { pricingParserExecuted?: boolean }).pricingParserExecuted).toBe(false);
  });

  test('rejects malformed, unterminated, and oversized parser inputs', () => {
    expect(() =>
      parsePublicPricingHtml('<script>self.__next_f.push([1,"unterminated")</script>')
    ).toThrow();
    expect(() => parsePublicPricingHtml(nextChunk('5:{"models":"wrong"}'))).toThrow();
    expect(() =>
      parsePublicPricingHtml('x'.repeat(PUBLIC_PRICING_MAX_RESPONSE_BYTES + 1))
    ).toThrow();
  });

  test('settles a near-cap hostile many-candidate payload with single-pass parsing', () => {
    const hostile = hostileModelsHtml();
    expect(new TextEncoder().encode(hostile).byteLength).toBeLessThan(
      PUBLIC_PRICING_MAX_RESPONSE_BYTES
    );
    expect(() => parsePublicPricingHtml(hostile)).toThrow(
      'Published pricing refresh failed: parse.'
    );
  });
});

describe('PlatformServices-owned public pricing cache behavior', () => {
  test('returns immediately, coalesces one detached refresh, persists normalized LKG, and reopens durably', async () => {
    let calls = 0;
    let release!: () => void;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const setupValue = await setup(async (input, init) => {
      calls += 1;
      requests.push({ url: String(input), init });
      await deferred;
      return validResponse({
        etag: '"fixture-v1"',
        'last-modified': 'Sun, 20 Jul 2026 00:00:00 GMT'
      });
    });

    expect(setupValue.service.current()).toMatchObject({
      snapshot: null,
      freshness: 'stale',
      availability: 'unavailable'
    });
    expect(setupValue.service.current().snapshot).toBeNull();
    expect(setupValue.service.current().snapshot).toBeNull();
    await waitUntil(() => calls === 1);
    release();
    await setupValue.service.refreshForTest();

    const current = setupValue.service.current();
    expect(current).toMatchObject({ freshness: 'fresh', availability: 'available' });
    expect(current.snapshot?.tiers).toHaveLength(reviewed.supportedTierCount);
    expect(calls).toBe(1);
    expect(requests[0]?.url).toBe(PUBLIC_PRICING_URL);
    expect(requests[0]?.init).toMatchObject({
      method: 'GET',
      credentials: 'omit',
      redirect: 'manual'
    });
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get('accept')).toBe('text/html');
    expect(headers.get('user-agent')).toBe(PUBLIC_PRICING_USER_AGENT);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('if-none-match')).toBeNull();
    expect(requests[0]?.init?.body).toBeUndefined();

    const persisted = JSON.stringify(stored(setupValue.settings));
    expect(persisted).not.toContain('fixture-images');
    expect(persisted).not.toContain('priceUSD');
    expect(persisted).not.toContain('description');
    expect(persisted).not.toContain(fixtureHtml.slice(0, 40));

    let restartCalls = 0;
    const restarted = new PublicPricingService({
      settings: setupValue.settings,
      gate: setupValue.gate,
      fetch: async () => {
        restartCalls += 1;
        return validResponse();
      }
    });
    expect(restarted.current()).toMatchObject({ freshness: 'fresh', availability: 'available' });
    expect(restartCalls).toBe(0);
  });

  test('uses the exact 24-hour TTL and conditional 304 verification without changing tiers/hash', async () => {
    let now = 0;
    const requests: RequestInit[] = [];
    let calls = 0;
    const setupValue = await setup(
      async (_input, init) => {
        requests.push(init ?? {});
        calls += 1;
        return calls === 1
          ? validResponse({
              etag: '"fixture-v1"',
              'last-modified': 'Thu, 01 Jan 1970 00:00:00 GMT'
            })
          : new Response(null, { status: 304 });
      },
      { now: () => now }
    );
    setupValue.service.current();
    await setupValue.service.refreshForTest();
    const first = setupValue.service.current().snapshot;
    expect(first).not.toBeNull();

    now = PUBLIC_PRICING_TTL_MS - 1;
    expect(setupValue.service.current().freshness).toBe('fresh');
    expect(calls).toBe(1);
    now = PUBLIC_PRICING_TTL_MS;
    expect(setupValue.service.current()).toMatchObject({
      freshness: 'stale',
      availability: 'available'
    });
    await setupValue.service.refreshForTest();
    const second = setupValue.service.current().snapshot;
    expect(calls).toBe(2);
    expect(second?.pricingHash).toBe(first?.pricingHash);
    expect(second?.tiers).toEqual(first?.tiers);
    expect(second?.source.verifiedAt).toBe(new Date(now).toISOString());
    const conditional = new Headers(requests[1]?.headers);
    expect(conditional.get('if-none-match')).toBe('"fixture-v1"');
    expect(conditional.get('if-modified-since')).toBe('Thu, 01 Jan 1970 00:00:00 GMT');
  });

  test('persists deterministic exponential backoff and suppresses attempts until due', async () => {
    let now = 0;
    let calls = 0;
    const setupValue = await setup(
      async () => {
        calls += 1;
        return calls === 1 ? validResponse() : new Response('unavailable', { status: 503 });
      },
      { now: () => now }
    );
    setupValue.service.current();
    await setupValue.service.refreshForTest();
    const lkgHash = setupValue.service.current().snapshot?.pricingHash;

    now = PUBLIC_PRICING_TTL_MS;
    expect(setupValue.service.current().freshness).toBe('stale');
    await setupValue.service.refreshForTest();
    expect(setupValue.service.current().snapshot?.pricingHash).toBe(lkgHash);
    expect(stored(setupValue.settings)).toMatchObject({
      failureCount: 1,
      nextAttemptAt: new Date(now + PUBLIC_PRICING_BACKOFF_BASE_MS).toISOString(),
      lastFailureCategory: 'http'
    });
    const afterFailure = calls;
    now += PUBLIC_PRICING_BACKOFF_BASE_MS - 1;
    setupValue.service.current();
    await Bun.sleep(0);
    expect(calls).toBe(afterFailure);
    now += 1;
    setupValue.service.current();
    await setupValue.service.refreshForTest();
    expect(stored(setupValue.settings)).toMatchObject({
      failureCount: 2,
      nextAttemptAt: new Date(now + PUBLIC_PRICING_BACKOFF_BASE_MS * 2).toISOString()
    });
  });

  test.each([
    [
      'network',
      async () => {
        throw new TypeError('fixture reset');
      }
    ],
    ['http', async () => new Response('bad', { status: 500 })],
    ['parse', async () => new Response('<html>no data</html>')],
    [
      'schema',
      async () =>
        new Response(nextChunk('5:{"models":[{"category":"Image","pricingTiers":"bad"}]}'))
    ],
    [
      'empty-inventory',
      async () =>
        new Response(
          modelsHtml([
            {
              category: 'Image',
              pricingTiers: [{ model: 'unknown-fixture', credits: 1, unit: 'per image' }]
            }
          ])
        )
    ],
    [
      'oversize',
      async () =>
        new Response('x', {
          headers: { 'content-length': String(PUBLIC_PRICING_MAX_RESPONSE_BYTES + 1) }
        })
    ],
    [
      'timeout',
      async (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true
          });
        })
    ]
  ] as Array<[PricingRefreshFailureCategory, FetchLike]>)(
    'preserves LKG for %s failures',
    async (category, failure) => {
      let now = 0;
      let calls = 0;
      const setupValue = await setup(
        async (input, init) => {
          calls += 1;
          return calls === 1 ? validResponse() : failure(input, init);
        },
        { now: () => now, timeoutMs: 5 }
      );
      setupValue.service.current();
      await setupValue.service.refreshForTest();
      const lkg = setupValue.service.current().snapshot;
      now = PUBLIC_PRICING_TTL_MS;
      expect(setupValue.service.current()).toMatchObject({
        freshness: 'stale',
        availability: 'available'
      });
      await setupValue.service.refreshForTest();
      expect(setupValue.service.current().snapshot).toEqual(lkg);
      expect(stored(setupValue.settings)).toMatchObject({ lastFailureCategory: category });
    }
  );

  test('caps a streamed body at 1 MiB and cancels the provider stream', async () => {
    let cancelled = false;
    const setupValue = await setup(async () => {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(PUBLIC_PRICING_MAX_RESPONSE_BYTES + 1));
          },
          cancel() {
            cancelled = true;
          }
        })
      );
    });
    setupValue.service.current();
    await setupValue.service.refreshForTest();
    expect(cancelled).toBe(true);
    expect(stored(setupValue.settings)).toMatchObject({ lastFailureCategory: 'oversize' });
  });

  test('follows at most two manual redirects on exact-host HTTPS only', async () => {
    const urls: string[] = [];
    const setupValue = await setup(async (input) => {
      urls.push(String(input));
      if (urls.length === 1)
        return new Response(null, { status: 302, headers: { location: '/one' } });
      if (urls.length === 2)
        return new Response(null, {
          status: 307,
          headers: { location: 'https://poyo.ai/two' }
        });
      return validResponse();
    });
    setupValue.service.current();
    await setupValue.service.refreshForTest();
    expect(urls).toEqual(['https://poyo.ai/pricing', 'https://poyo.ai/one', 'https://poyo.ai/two']);
    expect(setupValue.service.current().availability).toBe('available');
  });

  test.each([
    ['http scheme', 'http://poyo.ai/next'],
    ['subdomain', 'https://cdn.poyo.ai/next'],
    ['other host', 'https://example.com/next'],
    ['credentials', 'https://user@poyo.ai/next'],
    ['port', 'https://poyo.ai:444/next']
  ])('rejects redirect target %s', async (_name, location) => {
    const setupValue = await setup(
      async () => new Response(null, { status: 302, headers: { location } })
    );
    setupValue.service.current();
    await setupValue.service.refreshForTest();
    expect(stored(setupValue.settings)).toMatchObject({ lastFailureCategory: 'redirect' });
  });

  test('rejects a third exact-host redirect', async () => {
    let calls = 0;
    const setupValue = await setup(async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location: `/redirect-${calls}` } });
    });
    setupValue.service.current();
    await setupValue.service.refreshForTest();
    expect(calls).toBe(3);
    expect(stored(setupValue.settings)).toMatchObject({ lastFailureCategory: 'redirect' });
  });

  test('maintenance refusal is immediate, performs no fetch, and reports only a safe category', async () => {
    const gate = new MaintenanceGate();
    const lease = await gate.upgradeToExclusiveMaintenance(
      gate.acquireMaintenanceInitiator('fixture-maintenance')
    );
    let calls = 0;
    const failures: PricingRefreshFailureCategory[] = [];
    const setupValue = await setup(
      async () => {
        calls += 1;
        return validResponse();
      },
      {
        gate,
        reportFailure: (category) => {
          failures.push(category);
        }
      }
    );
    expect(setupValue.service.current()).toMatchObject({
      snapshot: null,
      availability: 'unavailable'
    });
    expect(calls).toBe(0);
    expect(failures).toEqual(['admission-refused']);
    lease.reopenBeforePublication();
  });

  test('exclusive maintenance drains an admitted refresh whose writer update is refused', async () => {
    const gate = new MaintenanceGate();
    let calls = 0;
    let release!: () => void;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const failures: PricingRefreshFailureCategory[] = [];
    const setupValue = await setup(
      async () => {
        calls += 1;
        await deferred;
        return validResponse();
      },
      {
        gate,
        reportFailure: (category) => {
          failures.push(category);
        }
      }
    );
    setupValue.service.current();
    await waitUntil(() => calls === 1);
    const upgrade = gate.upgradeToExclusiveMaintenance(
      gate.acquireMaintenanceInitiator('fixture-maintenance')
    );
    await expectPending(upgrade);
    release();
    const lease = await upgrade;
    expect(stored(setupValue.settings)).toBeNull();
    expect(failures).toContain('write-refused');
    expect(gate.status().detachedTasks).toBe(0);
    lease.reopenBeforePublication();
  });

  test('exclusive maintenance drains an admitted hostile parser refresh', async () => {
    const gate = new MaintenanceGate();
    const failures: PricingRefreshFailureCategory[] = [];
    let calls = 0;
    const setupValue = await setup(
      async () => {
        calls += 1;
        return new Response(hostileModelsHtml(), { status: 200 });
      },
      {
        gate,
        reportFailure: (category) => {
          failures.push(category);
        }
      }
    );
    setupValue.service.current();
    const lease = await gate.upgradeToExclusiveMaintenance(
      gate.acquireMaintenanceInitiator('hostile-pricing-maintenance')
    );
    expect(calls).toBe(1);
    expect(failures).toContain('parse');
    expect(gate.status().detachedTasks).toBe(0);
    lease.reopenBeforePublication();
  });

  test('catches asynchronous detached rejection even when the reporter also rejects', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    cleanups.push(() => {
      process.off('unhandledRejection', onUnhandled);
    });
    const settings = {
      get: () => null,
      set: () => {
        throw new Error('not reached');
      }
    };
    const service = new PublicPricingService({
      settings,
      gate: {
        trackDetached: <T>() => Promise.reject<T>(new Error('fixture detached rejection')),
        withWriterPermit: async <T>(_label: string, operation: () => Promise<T>) => operation()
      },
      fetch: async () => validResponse(),
      reportFailure: async () => {
        throw new Error('fixture reporter rejection');
      }
    });
    expect(service.current().availability).toBe('unavailable');
    await Bun.sleep(10);
    expect(unhandled).toEqual([]);
  });
});
