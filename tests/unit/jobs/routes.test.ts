import { describe, expect, test } from 'bun:test';
import { safeJobDto } from '../../../src/lib/server/jobs/events';
import {
  runtimeJobCreateDelay,
  runtimeJobTimings,
  runtimeOperationsSettings
} from '../../../src/lib/server/jobs/runtime-settings';
import { DEFAULT_OPERATIONS_SETTINGS } from '../../../src/lib/server/settings/operations-settings';
import { createJobFixture, createTestJob } from '../../helpers/job-fixture';

describe('job HTTP boundaries', () => {
  test('PERF-04 accelerated worker timings are test-only and bounded', () => {
    expect(() => runtimeJobTimings({ PLS_TEST_JOB_POLL_MS: '50' })).toThrow('PLS_TEST_MODE=1');
    expect(() => runtimeJobTimings({ PLS_TEST_MODE: '1', PLS_TEST_JOB_POLL_MS: '1' })).toThrow(
      'between 25 and 10000'
    );
    expect(
      runtimeJobTimings({
        PLS_TEST_MODE: '1',
        PLS_TEST_JOB_POLL_MS: '75',
        PLS_TEST_JOB_WORKER_MS: '50'
      })
    ).toEqual({ pollDelayMs: 75, workerIntervalMs: 50 });
    expect(() => runtimeJobCreateDelay({ PLS_TEST_JOB_CREATE_MS: '600' })).toThrow(
      'PLS_TEST_MODE=1'
    );
    expect(runtimeJobCreateDelay({ PLS_TEST_MODE: '1', PLS_TEST_JOB_CREATE_MS: '600' })).toBe(600);
  });

  test('SET-06 coordinator settings use validated persisted values and fail closed to defaults', () => {
    const persisted = {
      ...DEFAULT_OPERATIONS_SETTINGS,
      polling: { intervalMs: 12_000, staleAfterMs: 345_000 },
      downloads: { automatic: false }
    };
    expect(runtimeOperationsSettings(persisted)).toMatchObject({
      polling: persisted.polling,
      downloads: persisted.downloads
    });
    expect(runtimeOperationsSettings({ polling: { intervalMs: -1 } })).toEqual(
      DEFAULT_OPERATIONS_SETTINGS
    );
    expect(runtimeOperationsSettings(undefined)).toEqual(DEFAULT_OPERATIONS_SETTINGS);
  });

  test('SEC-04 every job mutation applies same-origin bounded JSON checks', async () => {
    const routes = [
      'src/routes/api/jobs/+server.ts',
      'src/routes/api/jobs/[jobId]/refresh/+server.ts',
      'src/routes/api/jobs/[jobId]/outputs/[outputId]/retry/+server.ts',
      'src/routes/api/jobs/[jobId]/rerun/+server.ts',
      'src/routes/api/jobs/[jobId]/retry-ambiguous/+server.ts',
      'src/routes/api/library/[jobId]/favorite/+server.ts',
      'src/routes/api/library/[jobId]/pin/+server.ts',
      'src/routes/api/library/[jobId]/tags/+server.ts',
      'src/routes/api/library/[jobId]/outputs/[outputId]/delete/+server.ts'
    ];
    for (const route of routes) {
      expect(await Bun.file(route).text()).toContain('readSameOriginJson');
    }
  });

  test('JOB-10 create route delegates browser data to authoritative request preparation', async () => {
    const route = await Bun.file('src/routes/api/jobs/+server.ts').text();
    expect(route).toContain('prepareJobCreateRequest');
    expect(route).not.toContain('CreateJobRequest');
    expect(route).not.toContain('normalizedPayload: input');
    const prepareIndex = route.indexOf('await prepareJobCreateRequest');
    const pricingIndex = route.indexOf('withEstimatedJobCreateRequest(prepared');
    const createIndex = route.indexOf('runtime.repository.create');
    expect(pricingIndex).toBeGreaterThan(prepareIndex);
    expect(createIndex).toBeGreaterThan(pricingIndex);
    expect(route).toContain(
      'withEstimatedJobCreateRequest(prepared, platform.pricing, runtime.repository)'
    );
    expect(route).not.toContain('refreshForTest');
  });

  test('request preview adds a cache-only estimate after authoritative normalization', async () => {
    const route = await Bun.file('src/routes/api/requests/preview/+server.ts').text();
    const helper = await Bun.file('src/lib/server/pricing/estimate-request.ts').text();
    const normalizeIndex = helper.indexOf('normalizeRegistryRequest');
    const currentIndex = helper.indexOf('pricing.current()');
    const estimateIndex = helper.indexOf('estimateNormalizedRegistryRequest');
    expect(normalizeIndex).toBeGreaterThan(-1);
    expect(currentIndex).toBeGreaterThan(normalizeIndex);
    expect(estimateIndex).toBeGreaterThan(normalizeIndex);
    expect(route).toContain(
      'normalizeEstimatedRegistryRequest(body, platform.pricing, runtime.repository)'
    );
    expect(helper).toContain('return { ...preview, estimate }');
    expect(route).not.toContain('refreshForTest');
  });

  test('UPLOAD-08 source intake and verified snapshot complete before any Poyo client exists', async () => {
    const route = await Bun.file('src/routes/api/sources/+server.ts').text();
    const intakeIndex = route.indexOf('await intakeLocalSource');
    const registerIndex = route.indexOf('await managedSources.register');
    const cleanupAuthorityIndex = route.indexOf('registeredSourceId = registered.id');
    const verifyIndex = route.indexOf('await readVerifiedManagedSourceBlob');
    const clientIndex = route.indexOf('await createPoyoClient');
    const uploadIndex = route.indexOf('await client.upload');
    const responseIndex = route.indexOf('return Response.json', uploadIndex);
    const responseSourceIndex = route.indexOf('source: {', responseIndex);
    const responseUploadIndex = route.indexOf('upload: {', responseSourceIndex);
    const catchIndex = route.indexOf('} catch (error)');
    expect(intakeIndex).toBeGreaterThan(-1);
    expect(registerIndex).toBeGreaterThan(intakeIndex);
    expect(cleanupAuthorityIndex).toBeGreaterThan(registerIndex);
    expect(verifyIndex).toBeGreaterThan(cleanupAuthorityIndex);
    expect(clientIndex).toBeGreaterThan(verifyIndex);
    expect(uploadIndex).toBeGreaterThan(verifyIndex);
    expect(responseIndex).toBeGreaterThan(uploadIndex);
    expect(responseSourceIndex).toBeGreaterThan(responseIndex);
    expect(responseUploadIndex).toBeGreaterThan(responseSourceIndex);
    expect(catchIndex).toBeGreaterThan(responseUploadIndex);
    expect(route).toContain('readMediaPrivacySettings(platform.settings)');
    expect(route).not.toContain('sourceId = source.id');
    expect(route.slice(catchIndex)).toContain('if (registeredSourceId && managedSources)');
    expect(route.slice(catchIndex)).toContain('discardUnreferenced(registeredSourceId)');

    const postRegistration = route.slice(registerIndex);
    const uploadRequest = route.slice(uploadIndex, responseIndex);
    for (const mapping of [
      'mimeType: registered.mimeType',
      'sizeBytes: registered.byteSize',
      'mediaKind: registered.mediaKind',
      'fileName: neutralSourceUploadName(registered.id, registered.mimeType)'
    ]) {
      expect(uploadRequest).toContain(mapping);
    }

    const sourceResponse = route.slice(responseSourceIndex, responseUploadIndex);
    for (const mapping of [
      'id: registered.id',
      'name: registered.originalName',
      'mediaKind: registered.mediaKind',
      'mimeType: registered.mimeType',
      'sizeBytes: registered.byteSize',
      'availability: registered.availability'
    ]) {
      expect(sourceResponse).toContain(mapping);
    }
    expect(postRegistration).not.toMatch(/\bsource\./);
  });

  test('JOB-14 rerun blocks before reconcile and maps repository errors safely', async () => {
    const route = await Bun.file('src/routes/api/jobs/[jobId]/rerun/+server.ts').text();
    const rerunIndex = route.indexOf('runtime.repository.rerunAsNew');
    const reconcileIndex = route.indexOf('runtime.coordinator.reconcile');
    expect(rerunIndex).toBeGreaterThan(-1);
    expect(reconcileIndex).toBeGreaterThan(rerunIndex);
    expect(route).toContain('catch (error)');
    expect(route).toContain('return jobHttpError(error)');
  });

  test('SEC-04 private media streaming supports HEAD and never serializes filesystem paths', async () => {
    const route = await Bun.file('src/routes/api/media/[outputId]/+server.ts').text();
    expect(route).toContain('serveVerifiedMediaOutput');
    expect(route).toContain('export const HEAD');
    expect(route).not.toContain('Response.json');
    const download = await Bun.file('src/routes/api/media/[outputId]/download/+server.ts').text();
    expect(download).toContain('attachment: true');
    const detail = await Bun.file('src/lib/components/library/JobDetailView.svelte').text();
    expect(detail).toContain('Open in browser');
    expect(detail).toContain('download data-sveltekit-reload');
    expect(detail).toMatch(/outputs\/\$\{outputId\}\/delete/);
    expect(detail).toContain('const historyPageSize = 20');
    expect(detail).toContain('job.history.slice(0, visibleHistoryCount)');
    expect(detail).toContain('Show 20 older events');
    for (const removedRoute of [
      'src/routes/api/library/[jobId]/open-folder/+server.ts',
      'src/routes/api/media/[outputId]/open-native/+server.ts',
      'src/routes/api/media/[outputId]/reveal/+server.ts'
    ]) {
      expect(await Bun.file(removedRoute).exists(), removedRoute).toBe(false);
    }
  });

  test('SEC-04 studio mutations apply bounded same-origin request checks', async () => {
    for (const route of [
      'src/routes/api/presets/+server.ts',
      'src/routes/api/presets/[presetId]/+server.ts',
      'src/routes/api/model-preferences/+server.ts',
      'src/routes/api/account/balance/+server.ts'
    ]) {
      expect(await Bun.file(route).text()).toContain('readSameOriginJson');
    }
    expect(await Bun.file('src/routes/api/sources/+server.ts').text()).toContain(
      'intakeLocalSource'
    );
    expect(await Bun.file('src/lib/server/media/source-intake.ts').text()).toContain(
      'assertSameOriginMultipart'
    );
  });

  test('SEC-04 safe live DTOs omit guided and normalized request payloads', async () => {
    const fixture = await createJobFixture();
    try {
      const dto = safeJobDto(createTestJob(fixture.repository, 'safe-dto'));
      expect(dto).not.toHaveProperty('guidedRequest');
      expect(dto).not.toHaveProperty('normalizedPayload');
      expect(JSON.stringify(dto)).not.toContain('calm coast');
    } finally {
      await fixture.cleanup();
    }
  });
});
