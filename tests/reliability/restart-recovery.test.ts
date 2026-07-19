import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { join } from 'node:path';
import { openDatabase } from '../../src/lib/server/platform/database';
import { JobRepository } from '../../src/lib/server/jobs/repository';
import { createTemporaryDirectory } from '../helpers/temporary-directory';
import { startStudioMockPoyoServer } from '../helpers/studio-mock-poyo-server';

setDefaultTimeout(30_000);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

async function runWorker(
  mode: 'submit' | 'recover' | 'enqueue-guarded' | 'recover-guarded',
  root: string,
  baseUrl: string
) {
  const child = Bun.spawn({
    cmd: [process.execPath, 'tests/reliability/restart-worker.ts', mode, root, baseUrl],
    stdout: 'pipe',
    stderr: 'pipe'
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  if (exitCode !== 0) throw new Error(`Restart worker failed (${exitCode}): ${stderr}`);
  return JSON.parse(stdout.trim()) as {
    jobId: string;
    phase: string;
    attentionCode?: string | null;
  };
}

test('JOB-03 separate Bun processes recover one paid task and verify its output', async () => {
  const temporary = await createTemporaryDirectory('poyo-restart-');
  const mock = await startStudioMockPoyoServer();
  cleanups.push(temporary.cleanup, mock.stop);

  const submitted = await runWorker('submit', temporary.path, mock.baseUrl);
  expect(submitted.phase).toBe('monitoring');
  expect(
    mock.requests.filter((request) => request.pathname === '/api/generate/submit')
  ).toHaveLength(1);

  const recovered = await runWorker('recover', temporary.path, mock.baseUrl);
  expect(recovered).toEqual({ jobId: submitted.jobId, phase: 'complete' });
  expect(
    mock.requests.filter((request) => request.pathname === '/api/generate/submit')
  ).toHaveLength(1);

  const database = await openDatabase(join(temporary.path, 'studio.sqlite'));
  try {
    const repository = new JobRepository(database);
    expect(repository.get(submitted.jobId)).toMatchObject({
      poyoTaskId: 'mock-task-1',
      remoteStatus: 'finished',
      localPhase: 'complete'
    });
    expect(repository.outputs(submitted.jobId)[0]).toMatchObject({
      downloadState: 'verified',
      byteSize: 68
    });
    expect(repository.eventsAfter(0).map((event) => event.eventType)).toContain(
      'download.verified'
    );
  } finally {
    database.close();
  }
});

test('JOB-03 queued work remains guarded immediately before dispatch after process restart', async () => {
  const temporary = await createTemporaryDirectory('poyo-restart-guard-');
  const mock = await startStudioMockPoyoServer();
  cleanups.push(temporary.cleanup, mock.stop);

  const queued = await runWorker('enqueue-guarded', temporary.path, mock.baseUrl);
  expect(queued.phase).toBe('submission_prepared');
  expect(mock.requests).toHaveLength(0);

  const recovered = await runWorker('recover-guarded', temporary.path, mock.baseUrl);
  expect(recovered).toMatchObject({
    jobId: queued.jobId,
    phase: 'requires_attention',
    attentionCode: 'public_ipv4_guard_match'
  });
  expect(
    mock.requests.filter((request) => request.pathname === '/api/generate/submit')
  ).toHaveLength(0);
  expect(mock.ipRequests.length).toBeGreaterThan(0);
});
