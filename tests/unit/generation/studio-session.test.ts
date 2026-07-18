import { describe, expect, test } from 'bun:test';
import type { StudioJobDto } from '../../../src/lib/features/generation/contracts';
import {
  applyStudioJobEvent,
  compareStudioJobRecency,
  latestSuccessfulStudioJob,
  mergeKnownStudioSnapshot,
  nextStudioResultCandidate,
  upsertStudioSessionJob
} from '../../../src/lib/features/generation/studio-session';

function job(overrides: Partial<StudioJobDto> = {}): StudioJobDto {
  return {
    id: 'job-a',
    workflow: 'text-to-image',
    publicModelId: 'provider/model',
    localPhase: 'monitoring',
    remoteStatus: 'running',
    failureDomain: 'none',
    attentionCode: null,
    poyoTaskId: 'task-a',
    progress: 20,
    estimatedCredits: null,
    actualCredits: null,
    lastPolledAt: null,
    createdAt: '2026-07-18T10:00:00.000Z',
    updatedAt: '2026-07-18T10:00:01.000Z',
    completedAt: null,
    ...overrides
  };
}

describe('studio session jobs', () => {
  test('merges POST, known snapshots and SSE without admitting unrelated history', () => {
    let jobs = upsertStudioSessionJob({}, job());
    jobs = mergeKnownStudioSnapshot(jobs, [
      job({ progress: 40, updatedAt: '2026-07-18T10:00:02.000Z' }),
      job({ id: 'historical-job', updatedAt: '2026-07-18T10:00:03.000Z' })
    ]);
    jobs = applyStudioJobEvent(jobs, {
      jobId: 'job-a',
      localPhase: 'complete',
      remoteStatus: 'finished',
      failureDomain: 'none',
      progress: 100,
      observedAt: '2026-07-18T10:00:04.000Z'
    });
    expect(Object.keys(jobs)).toEqual(['job-a']);
    expect(jobs['job-a']).toMatchObject({ localPhase: 'complete', progress: 100 });
    expect(jobs['job-a']?.completedAt).toBe('2026-07-18T10:00:04.000Z');
  });

  test('rejects stale updates and terminal regressions', () => {
    const complete = job({
      localPhase: 'complete',
      remoteStatus: 'finished',
      progress: 100,
      updatedAt: '2026-07-18T10:00:04.000Z',
      completedAt: '2026-07-18T10:00:04.000Z'
    });
    const jobs = upsertStudioSessionJob(
      { 'job-a': complete },
      job({ progress: 10, updatedAt: '2026-07-18T10:00:03.000Z' })
    );
    const regressed = applyStudioJobEvent(jobs, {
      jobId: 'job-a',
      localPhase: 'monitoring',
      remoteStatus: 'running',
      failureDomain: 'none',
      progress: 80,
      observedAt: '2026-07-18T10:00:05.000Z'
    });
    expect(regressed['job-a']).toEqual(complete);
  });

  test('chooses the latest successful completion deterministically', () => {
    const jobs = {
      a: job({
        id: 'a',
        localPhase: 'complete',
        remoteStatus: 'finished',
        completedAt: null,
        updatedAt: '2026-07-18T10:00:03.000Z'
      }),
      b: job({
        id: 'b',
        localPhase: 'complete',
        remoteStatus: 'finished',
        completedAt: '2026-07-18T10:00:04.000Z',
        updatedAt: '2026-07-18T10:00:05.000Z'
      }),
      c: job({
        id: 'c',
        localPhase: 'complete',
        remoteStatus: 'failed',
        completedAt: '2026-07-18T10:00:06.000Z',
        updatedAt: '2026-07-18T10:00:06.000Z'
      }),
      d: job({
        id: 'd',
        localPhase: 'complete',
        remoteStatus: 'finished',
        completedAt: '2026-07-18T10:00:04.000Z',
        updatedAt: '2026-07-18T10:00:04.000Z'
      })
    };
    expect(latestSuccessfulStudioJob(jobs)?.id).toBe('d');
  });

  test('falls back after a newer empty result without letting an older result regress the preview', () => {
    const older = job({
      id: 'older',
      localPhase: 'complete',
      remoteStatus: 'finished',
      completedAt: '2026-07-18T10:00:03.000Z',
      updatedAt: '2026-07-18T10:00:03.000Z'
    });
    const newer = job({
      id: 'newer',
      localPhase: 'complete',
      remoteStatus: 'finished',
      completedAt: '2026-07-18T10:00:04.000Z',
      updatedAt: '2026-07-18T10:00:04.000Z'
    });
    const jobs = { older, newer };

    expect(nextStudioResultCandidate(jobs, {})?.id).toBe('newer');
    expect(nextStudioResultCandidate(jobs, { newer: 'loading' })).toBeNull();
    expect(nextStudioResultCandidate(jobs, { newer: 'empty' })?.id).toBe('older');
    expect(compareStudioJobRecency(older, newer)).toBeLessThan(0);
  });
});
