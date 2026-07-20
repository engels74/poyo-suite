import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareJobCreateRequest } from '../../../src/lib/server/jobs/create-request';
import { JobRepository } from '../../../src/lib/server/jobs/repository';
import { openDatabase } from '../../../src/lib/server/platform/database';
import { MaintenanceGate } from '../../../src/lib/server/platform/maintenance-gate';
import {
  normalizeEstimatedRegistryRequest,
  withEstimatedJobCreateRequest
} from '../../../src/lib/server/pricing/estimate-request';
import {
  type PricingRefreshFailureCategory,
  PublicPricingService
} from '../../../src/lib/server/pricing/public-pricing';
import { seedImageRegistry } from '../../../src/lib/server/registry/repository';
import { SettingsRepository } from '../../../src/lib/server/settings/settings-repository';
import { createTemporaryDirectory } from '../../helpers/temporary-directory';

const fixtureHtml = readFileSync(
  join(import.meta.dir, '../../fixtures/pricing/public-pricing.html'),
  'utf8'
);
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error('Condition did not settle.');
}

async function expectImmediate<T>(operation: () => Promise<T>): Promise<T> {
  const outcome = await Promise.race([
    operation().then((value) => ({ state: 'resolved' as const, value })),
    Bun.sleep(25).then(() => ({ state: 'blocked' as const }))
  ]);
  if (outcome.state === 'blocked') throw new Error('Cache-only estimate operation blocked.');
  return outcome.value;
}

describe('cache-only preview and accepted job estimates', () => {
  test('an admitted unresolved refresh never blocks and its eventual result serves later previews', async () => {
    const temporary = await createTemporaryDirectory('request-estimates-');
    const database = await openDatabase(join(temporary.path, 'studio.sqlite'));
    cleanups.push(() => temporary.cleanup());
    cleanups.push(() => database.close());
    seedImageRegistry(database);
    const settings = new SettingsRepository(database);
    const gate = new MaintenanceGate();
    const failures: PricingRefreshFailureCategory[] = [];
    let calls = 0;
    let release!: () => void;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pricing = new PublicPricingService({
      settings,
      gate,
      now: () => Date.parse('2026-07-20T12:00:00.000Z'),
      fetch: async () => {
        calls += 1;
        await deferred;
        return new Response(fixtureHtml, { status: 200 });
      },
      reportFailure: (category) => {
        failures.push(category);
      }
    });
    const previewRequest = {
      entryKey: 'seedream-5.0-pro:text-to-image',
      values: { prompt: 'Never persisted in estimate provenance' }
    };

    const firstPreview = await expectImmediate(async () =>
      normalizeEstimatedRegistryRequest(previewRequest, pricing)
    );
    expect(firstPreview).toMatchObject({
      request: { model: 'seedream-5.0-pro' },
      estimate: { credits: null, availability: 'unavailable', freshness: 'stale' }
    });
    await waitUntil(() => calls === 1);

    const prepared = await prepareJobCreateRequest(
      database,
      {
        actionId: '019b0000-0000-7000-8000-000000000201',
        ...previewRequest,
        expertOverrides: [],
        inputs: []
      },
      async () => {
        throw new Error('No managed source should be resolved.');
      }
    );
    const repository = new JobRepository(database, () => new Date('2026-07-20T12:00:00.000Z'));
    const job = await expectImmediate(async () =>
      repository.create(withEstimatedJobCreateRequest(prepared, pricing))
    );
    expect(job.estimatedCredits).toBeNull();
    expect(calls).toBe(1);
    const created = repository
      .eventsAfter(0)
      .find((event) => event.jobId === job.id && event.eventType === 'job.created');
    expect(created?.payload).toMatchObject({
      estimate: {
        credits: null,
        signature: null,
        pricingHash: null,
        registryVersion: 'image-2026-07-20.1'
      }
    });
    expect(JSON.stringify(created?.payload)).not.toContain(previewRequest.values.prompt);
    expect(failures).toEqual([]);

    release();
    await pricing.refreshForTest();
    const laterPreview = normalizeEstimatedRegistryRequest(previewRequest, pricing);
    expect(laterPreview.estimate).toMatchObject({
      credits: 15,
      availability: 'available',
      freshness: 'fresh'
    });
    expect(calls).toBe(1);
  });

  test('refused refresh admission leaves preview and job acceptance immediate', async () => {
    const temporary = await createTemporaryDirectory('request-estimates-refused-');
    const database = await openDatabase(join(temporary.path, 'studio.sqlite'));
    cleanups.push(() => temporary.cleanup());
    cleanups.push(() => database.close());
    seedImageRegistry(database);
    const settings = new SettingsRepository(database);
    const gate = new MaintenanceGate();
    const lease = await gate.upgradeToExclusiveMaintenance(
      gate.acquireMaintenanceInitiator('request-estimates-refused')
    );
    const failures: PricingRefreshFailureCategory[] = [];
    let calls = 0;
    const pricing = new PublicPricingService({
      settings,
      gate,
      fetch: async () => {
        calls += 1;
        return new Response(fixtureHtml, { status: 200 });
      },
      reportFailure: (category) => {
        failures.push(category);
      }
    });
    const previewRequest = {
      entryKey: 'seedream-5.0-pro:text-to-image',
      values: { prompt: 'Admission refusal stays fail-open' }
    };
    try {
      const preview = await expectImmediate(async () =>
        normalizeEstimatedRegistryRequest(previewRequest, pricing)
      );
      expect(preview.estimate).toMatchObject({
        credits: null,
        availability: 'unavailable'
      });
      const prepared = await prepareJobCreateRequest(
        database,
        {
          actionId: '019b0000-0000-7000-8000-000000000202',
          ...previewRequest,
          expertOverrides: [],
          inputs: []
        },
        async () => {
          throw new Error('No managed source should be resolved.');
        }
      );
      const repository = new JobRepository(database);
      const job = await expectImmediate(async () =>
        repository.create(withEstimatedJobCreateRequest(prepared, pricing))
      );
      expect(job.estimatedCredits).toBeNull();
      expect(calls).toBe(0);
      expect(failures).toEqual(['admission-refused']);
    } finally {
      lease.reopenBeforePublication();
    }
  });
});
