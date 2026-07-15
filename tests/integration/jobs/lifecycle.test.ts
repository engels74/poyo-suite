import { afterEach, describe, expect, test } from 'bun:test';
import { exists, readdir } from 'node:fs/promises';
import { JobCoordinator, type JobPoyoGateway } from '../../../src/lib/server/jobs/coordinator';
import { OutputDownloader } from '../../../src/lib/server/jobs/downloader';
import { PoyoError } from '../../../src/lib/server/poyo/errors';
import type { PoyoStatusResult } from '../../../src/lib/server/poyo/types';
import { createJobFixture, createTestJob } from '../../helpers/job-fixture';

const cleanups: Array<() => Promise<void>> = [];
const publicDns = async () => [{ address: '93.184.216.34', family: 4 as const }];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
function accepted(fixture: Awaited<ReturnType<typeof createJobFixture>>, suffix: string) {
  const job = createTestJob(fixture.repository, suffix);
  const claim = fixture.repository.claimSubmission(job.id, 'setup', 1000);
  if (!claim) throw new Error('claim failed');
  fixture.repository.markSubmissionTransmitted(job.id, claim.token);
  fixture.repository.acknowledgeSubmission(job.id, claim.token, {
    taskId: `task-${suffix}`,
    statusRaw: 'not_started',
    status: 'not_started',
    createdTime: 'now'
  });
  const acceptedJob = fixture.repository.get(job.id);
  if (!acceptedJob) throw new Error('accepted job missing');
  return acceptedJob;
}
function gateway(overrides: Partial<JobPoyoGateway> = {}): JobPoyoGateway {
  return {
    submit: async () => ({
      taskId: 'task-default',
      statusRaw: 'not_started',
      status: 'not_started',
      createdTime: 'now'
    }),
    getStatus: async () => ({
      taskId: 'task-default',
      statusRaw: 'running',
      status: 'running',
      creditsAmount: 1,
      files: [],
      createdTime: 'now',
      progress: 25,
      errorMessage: null
    }),
    getBalance: async () => ({
      email: 'studio@example.test',
      creditsAmount: 100,
      fetchedAt: 'now'
    }),
    ...overrides
  };
}

describe('durable coordinator and media lifecycle', () => {
  test('JOB-02 two coordinators emit one paid submit and restart recovery resumes monitoring', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const job = createTestJob(fixture.repository, 'two-coordinators');
    let paid = 0;
    const poyo = gateway({
      submit: async () => {
        paid += 1;
        await Bun.sleep(5);
        return {
          taskId: 'task-once',
          statusRaw: 'not_started',
          status: 'not_started',
          createdTime: 'now'
        };
      }
    });
    const downloader = new OutputDownloader({
      repository: fixture.repository,
      paths: fixture.paths,
      resolveHost: publicDns,
      fetch: async () => new Response()
    });
    const a = new JobCoordinator({
      repository: fixture.repository,
      poyo,
      downloader,
      workerId: 'a'
    });
    const b = new JobCoordinator({
      repository: fixture.repository,
      poyo,
      downloader,
      workerId: 'b'
    });
    await Promise.all([a.recoverOnce(), b.recoverOnce()]);
    expect(paid).toBe(1);
    expect(fixture.repository.get(job.id)).toMatchObject({
      localPhase: 'monitoring',
      poyoTaskId: 'task-once'
    });
  });

  test('INT-05 ambiguous submit is frozen and never auto-retried after restart', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const job = createTestJob(fixture.repository, 'drop');
    let paid = 0;
    const poyo = gateway({
      submit: async () => {
        paid += 1;
        throw new PoyoError({
          category: 'network',
          technicalCode: 'socket_drop',
          message: 'uncertain',
          retryable: true,
          operation: 'submit'
        });
      }
    });
    const coordinator = new JobCoordinator({
      repository: fixture.repository,
      poyo,
      downloader: new OutputDownloader({ repository: fixture.repository, paths: fixture.paths }),
      workerId: 'worker'
    });
    await coordinator.recoverOnce();
    await coordinator.recoverOnce();
    expect(paid).toBe(1);
    expect(fixture.repository.get(job.id)).toMatchObject({
      attentionCode: 'submission_unknown',
      remoteStatus: 'unknown'
    });
  });

  test('JOB-04/05/06 poll failures do not fail generation and authoritative progress is monotonic', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const job = accepted(fixture, 'poll');
    let polls = 0;
    const observations: PoyoStatusResult[] = [
      {
        taskId: 'task-poll',
        statusRaw: 'running',
        status: 'running',
        creditsAmount: 2,
        files: [],
        createdTime: 'now',
        progress: 60,
        errorMessage: null
      },
      {
        taskId: 'task-poll',
        statusRaw: 'running',
        status: 'running',
        creditsAmount: 2,
        files: [],
        createdTime: 'now',
        progress: 40,
        errorMessage: null
      }
    ];
    const poyo = gateway({
      getStatus: async () => {
        polls += 1;
        if (polls === 1)
          throw new PoyoError({
            category: 'network',
            technicalCode: 'network_failure',
            message: 'offline',
            retryable: true,
            operation: 'status'
          });
        const observation = observations[polls - 2] ?? observations[1];
        if (!observation) throw new Error('observation missing');
        return observation;
      }
    });
    const coordinator = new JobCoordinator({
      repository: fixture.repository,
      poyo,
      downloader: new OutputDownloader({ repository: fixture.repository, paths: fixture.paths }),
      workerId: 'poller'
    });
    await coordinator.poll(job.id, true);
    expect(fixture.repository.get(job.id)?.remoteStatus).toBe('not_started');
    await coordinator.poll(job.id, true);
    await coordinator.poll(job.id, true);
    expect(fixture.repository.get(job.id)).toMatchObject({ remoteStatus: 'running', progress: 60 });
    expect(
      fixture.repository
        .eventsAfter(0)
        .filter((event) => event.eventType === 'status.observed')
        .map((event) => event.payload?.observedProgress)
    ).toEqual([60, 40]);
  });

  test('MEDIA-03/INT-08 uses atomic verified downloads and permits corrupt-output retry', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const job = accepted(fixture, 'download');
    fixture.repository.applyStatus(
      job.id,
      {
        taskId: job.poyoTaskId ?? 'task-download',
        statusRaw: 'finished',
        status: 'finished',
        creditsAmount: 3,
        files: [
          {
            url: 'https://media.example/result.png',
            fileType: 'image',
            label: null,
            format: 'png',
            contentType: 'image/png',
            fileName: 'result.png',
            fileSize: null
          }
        ],
        createdTime: 'now',
        progress: 100,
        errorMessage: null
      },
      1000
    );
    const output = fixture.repository.outputs(job.id)[0];
    if (!output) throw new Error('output missing');
    let attempt = 0;
    const downloader = new OutputDownloader({
      repository: fixture.repository,
      paths: fixture.paths,
      resolveHost: publicDns,
      fetch: async () => {
        attempt += 1;
        return new Response(
          attempt === 1
            ? new Uint8Array([1, 2, 3])
            : new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          { headers: { 'content-type': 'image/png' } }
        );
      }
    });
    await expect(downloader.download(output.id)).rejects.toThrow('signature');
    expect(fixture.repository.get(job.id)).toMatchObject({
      remoteStatus: 'finished',
      failureDomain: 'download'
    });
    const verified = await downloader.download(output.id);
    expect(verified.downloadState).toBe('verified');
    expect(verified.checksum).toHaveLength(64);
    expect(verified.localPath && (await exists(verified.localPath))).toBe(true);
    expect(await readdir(fixture.paths.temporary).catch(() => [])).toEqual([]);
    expect(
      fixture.database
        .query<{ count: number }, [string]>(
          'SELECT COUNT(*) count FROM download_attempts WHERE output_id=?'
        )
        .get(output.id)?.count
    ).toBe(2);
  });

  test('JOB-07 refreshes balance after terminal download without changing remote success', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const job = accepted(fixture, 'balance');
    let balances = 0;
    const status: PoyoStatusResult = {
      taskId: 'task-balance',
      statusRaw: 'finished',
      status: 'finished',
      creditsAmount: 4,
      files: [
        {
          url: 'https://media.example/result.png',
          fileType: 'image',
          label: null,
          format: 'png',
          contentType: 'image/png',
          fileName: 'result.png',
          fileSize: 8
        }
      ],
      createdTime: 'now',
      progress: 100,
      errorMessage: null
    };
    const poyo = gateway({
      getStatus: async () => status,
      getBalance: async () => {
        balances += 1;
        return { email: 'studio@example.test', creditsAmount: 96, fetchedAt: 'now' };
      }
    });
    const downloader = new OutputDownloader({
      repository: fixture.repository,
      paths: fixture.paths,
      resolveHost: publicDns,
      fetch: async () =>
        new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
          headers: { 'content-type': 'image/png' }
        })
    });
    const coordinator = new JobCoordinator({
      repository: fixture.repository,
      poyo,
      downloader,
      workerId: 'finisher'
    });
    await coordinator.poll(job.id, true);
    expect(fixture.repository.get(job.id)).toMatchObject({
      localPhase: 'complete',
      remoteStatus: 'finished',
      actualCredits: 4
    });
    expect(balances).toBe(1);
  });

  test('SET-06 persisted automatic-download policy is read for each recovery cycle', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const job = accepted(fixture, 'manual-download');
    let automaticDownloads = false;
    let downloads = 0;
    const coordinator = new JobCoordinator({
      repository: fixture.repository,
      poyo: gateway({
        getStatus: async () => ({
          taskId: 'task-manual-download',
          statusRaw: 'finished',
          status: 'finished',
          creditsAmount: 4,
          files: [
            {
              url: 'https://media.example/result.png',
              fileType: 'image',
              label: null,
              format: 'png',
              contentType: 'image/png',
              fileName: 'result.png',
              fileSize: 8
            }
          ],
          createdTime: 'now',
          progress: 100,
          errorMessage: null
        })
      }),
      downloader: new OutputDownloader({
        repository: fixture.repository,
        paths: fixture.paths,
        resolveHost: publicDns,
        fetch: async () => {
          downloads += 1;
          return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
            headers: { 'content-type': 'image/png' }
          });
        }
      }),
      runtimeSettings: () => ({
        pollDelayMs: 2_000,
        staleAfterMs: 60_000,
        automaticDownloads
      })
    });

    await coordinator.poll(job.id, true);
    expect(fixture.repository.get(job.id)).toMatchObject({
      localPhase: 'downloading',
      remoteStatus: 'finished',
      actualCredits: 4
    });
    expect(downloads).toBe(0);

    await coordinator.reconcile(job.id);
    expect(downloads).toBe(0);
    automaticDownloads = true;
    await coordinator.reconcile(job.id);
    expect(downloads).toBe(1);
    expect(fixture.repository.get(job.id)?.localPhase).toBe('complete');
  });
});
