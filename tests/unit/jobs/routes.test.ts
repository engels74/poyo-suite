import { describe, expect, test } from 'bun:test';
import { JobRequestError } from '../../../src/lib/server/jobs/create-request';
import { safeJobDto } from '../../../src/lib/server/jobs/events';
import { jobHttpError } from '../../../src/lib/server/jobs/http';
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
      'src/routes/api/library/[jobId]/open-folder/+server.ts',
      'src/routes/api/library/[jobId]/outputs/[outputId]/delete/+server.ts',
      'src/routes/api/media/[outputId]/open-native/+server.ts',
      'src/routes/api/media/[outputId]/reveal/+server.ts'
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
  });

  test('JOB-14 maps retired reruns to an exact safe 409 response', async () => {
    const response = jobHttpError(
      new JobRequestError(
        'retired_input_requires_review',
        'This Seedream 5 Pro job contains the retired n setting. Use Edit in studio to review current settings before creating a new paid job.',
        409
      )
    );
    expect(response.status).toBe(409);
    const responseText = await response.clone().text();
    expect(await response.json()).toEqual({
      error: {
        code: 'retired_input_requires_review',
        message:
          'This Seedream 5 Pro job contains the retired n setting. Use Edit in studio to review current settings before creating a new paid job.'
      }
    });
    expect(responseText).not.toMatch(/stack|payload|internal/i);
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
    expect(detail).toContain('download data-sveltekit-reload');
    for (const mutation of ['open-native', 'reveal']) {
      const source = await Bun.file(
        `src/routes/api/media/[outputId]/${mutation}/+server.ts`
      ).text();
      expect(source).toContain('resolveVerifiedMediaOutput');
      expect(source).not.toContain('localPath');
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
