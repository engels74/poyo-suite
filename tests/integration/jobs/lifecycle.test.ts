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
function finishedOutput(fixture: Awaited<ReturnType<typeof createJobFixture>>, suffix: string) {
  const job = accepted(fixture, suffix);
  fixture.repository.applyStatus(
    job.id,
    {
      taskId: `task-${suffix}`,
      statusRaw: 'finished',
      status: 'finished',
      creditsAmount: 1,
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
    },
    1_000
  );
  const output = fixture.repository.outputs(job.id)[0];
  if (!output) throw new Error('output missing');
  return { job, output };
}
function gateway(overrides: Partial<JobPoyoGateway> = {}): JobPoyoGateway {
  return {
    submit: async (_request, options) => {
      await options?.beforeDispatch?.();
      return {
        taskId: 'task-default',
        statusRaw: 'not_started',
        status: 'not_started',
        createdTime: 'now'
      };
    },
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
  test('IP guard policy blocks untransmitted submission once without ambiguity or recovery retry', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const job = createTestJob(fixture.repository, 'ip-policy');
    let gatewayCalls = 0;
    let balanceAttempts = 0;
    const coordinator = new JobCoordinator({
      repository: fixture.repository,
      poyo: gateway({
        submit: async () => {
          gatewayCalls += 1;
          throw new PoyoError({
            category: 'policy',
            technicalCode: 'public_ipv4_guard_match',
            message: 'Poyo was not contacted because the public IPv4 guard matched.',
            retryable: false,
            operation: 'submit'
          });
        },
        getBalance: async () => {
          balanceAttempts += 1;
          throw new Error('Balance must remain behind the same blocked transport boundary.');
        }
      }),
      downloader: new OutputDownloader({ repository: fixture.repository, paths: fixture.paths }),
      workerId: 'ip-policy-worker'
    });
    await coordinator.recoverOnce();
    await coordinator.recoverOnce();
    expect(gatewayCalls).toBe(1);
    expect(balanceAttempts).toBe(0);
    expect(fixture.repository.get(job.id)).toMatchObject({
      localPhase: 'requires_attention',
      attentionCode: 'public_ipv4_guard_match'
    });
    const intent = fixture.database
      .query<{ state: string; sent_at: string | null }, [string]>(
        'SELECT state,sent_at FROM submission_intents WHERE job_id=?'
      )
      .get(job.id);
    expect(intent).toEqual({ state: 'rejected', sent_at: null });
  });

  test('policy after possible transmit evidence preserves ambiguous submission truth', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const job = createTestJob(fixture.repository, 'ip-policy-ambiguous');
    const coordinator = new JobCoordinator({
      repository: fixture.repository,
      poyo: gateway({
        submit: async (_request, options) => {
          await options?.beforeDispatch?.();
          throw new PoyoError({
            category: 'policy',
            technicalCode: 'public_ipv4_guard_unavailable',
            message: 'Poyo was not contacted because public IPv4 verification failed.',
            retryable: false,
            operation: 'submit'
          });
        }
      }),
      downloader: new OutputDownloader({ repository: fixture.repository, paths: fixture.paths }),
      workerId: 'ip-policy-ambiguous-worker'
    });
    await coordinator.submit(job.id);
    expect(fixture.repository.get(job.id)).toMatchObject({
      localPhase: 'requires_attention',
      attentionCode: 'submission_unknown'
    });
  });

  test('samples balance before transmit evidence and preserves unknown truth after dispatch', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const job = createTestJob(fixture.repository, 'balance-before-transmit');
    const order: string[] = [];
    let balanceStarted = (): void => undefined;
    const balanceEntered = new Promise<void>((resolve) => {
      balanceStarted = resolve;
    });
    let failBalance = (): void => undefined;
    const balanceBlocked = new Promise<void>((resolve) => {
      failBalance = resolve;
    });
    const markSubmissionTransmitted = fixture.repository.markSubmissionTransmitted.bind(
      fixture.repository
    );
    fixture.repository.markSubmissionTransmitted = (jobId, token) => {
      order.push('transmitted');
      return markSubmissionTransmitted(jobId, token);
    };
    const coordinator = new JobCoordinator({
      repository: fixture.repository,
      poyo: gateway({
        submit: async (_request, options) => {
          await options?.beforeDispatch?.();
          order.push('dispatch');
          throw new PoyoError({
            category: 'network',
            technicalCode: 'socket_drop_after_dispatch',
            message: 'The submit outcome is unknown after dispatch.',
            retryable: true,
            operation: 'submit'
          });
        },
        getBalance: async () => {
          order.push('balance-started');
          balanceStarted();
          await balanceBlocked;
          order.push('balance-failed');
          throw new Error('Balance sampling failed before dispatch.');
        }
      }),
      downloader: new OutputDownloader({ repository: fixture.repository, paths: fixture.paths }),
      workerId: 'balance-before-transmit-worker'
    });

    const submission = coordinator.submit(job.id);
    await balanceEntered;

    expect(
      fixture.database
        .query<
          { state: string; sent_at: string | null; transport_evidence_json: string | null },
          [string]
        >('SELECT state,sent_at,transport_evidence_json FROM submission_intents WHERE job_id=?')
        .get(job.id)
    ).toEqual({ state: 'sending', sent_at: null, transport_evidence_json: null });
    expect(
      fixture.database
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) count FROM job_events WHERE job_id=? AND event_type='submission.transmitted'"
        )
        .get(job.id)?.count
    ).toBe(0);

    failBalance();
    await submission;

    expect(order).toEqual(['balance-started', 'balance-failed', 'transmitted', 'dispatch']);
    expect(
      fixture.database
        .query<{ state: string; sent_at: string | null }, [string]>(
          'SELECT state,sent_at FROM submission_intents WHERE job_id=?'
        )
        .get(job.id)
    ).toEqual({ state: 'unknown', sent_at: expect.any(String) });
    expect(fixture.repository.get(job.id)).toMatchObject({
      localPhase: 'requires_attention',
      attentionCode: 'submission_unknown'
    });
  });

  test('lost submission ownership before dispatch preserves established job truth', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const job = createTestJob(fixture.repository, 'claim-lost-before-dispatch');
    const markSubmissionTransmitted = fixture.repository.markSubmissionTransmitted.bind(
      fixture.repository
    );
    let rejectionSucceeded = false;
    fixture.repository.markSubmissionTransmitted = (jobId, token) => {
      rejectionSucceeded = fixture.repository.rejectUntransmittedPolicy(
        jobId,
        token,
        'public_ipv4_guard_match'
      );
      return markSubmissionTransmitted(jobId, token);
    };
    let upstreamDispatches = 0;
    let balanceAttempts = 0;
    const coordinator = new JobCoordinator({
      repository: fixture.repository,
      poyo: gateway({
        submit: async (_request, options) => {
          await options?.beforeDispatch?.();
          upstreamDispatches += 1;
          throw new Error('Upstream dispatch must not occur after ownership is lost.');
        },
        getBalance: async () => {
          balanceAttempts += 1;
          throw new Error('Balance sampling failed before the final submission claim check.');
        }
      }),
      downloader: new OutputDownloader({ repository: fixture.repository, paths: fixture.paths }),
      workerId: 'claim-lost-before-dispatch-worker'
    });

    await coordinator.submit(job.id);

    expect({ rejectionSucceeded, upstreamDispatches, balanceAttempts }).toEqual({
      rejectionSucceeded: true,
      upstreamDispatches: 0,
      balanceAttempts: 1
    });
    expect(fixture.repository.get(job.id)).toMatchObject({
      localPhase: 'requires_attention',
      attentionCode: 'public_ipv4_guard_match'
    });
  });

  test('explicit rerun remains behind the guard before a new paid dispatch', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const original = finishedOutput(fixture, 'ip-policy-rerun').job;
    const rerun = await fixture.repository.rerunAsNew(
      original.id,
      crypto.randomUUID(),
      async () => {
        throw new Error('This rerun has no managed source to refresh.');
      }
    );
    let gatewayCalls = 0;
    const coordinator = new JobCoordinator({
      repository: fixture.repository,
      poyo: gateway({
        submit: async (_request, options) => {
          gatewayCalls += 1;
          expect(options?.beforeDispatch).toBeFunction();
          throw new PoyoError({
            category: 'policy',
            technicalCode: 'public_ipv4_guard_match',
            message: 'Poyo was not contacted because the public IPv4 guard matched.',
            retryable: false,
            operation: 'submit'
          });
        }
      }),
      downloader: new OutputDownloader({ repository: fixture.repository, paths: fixture.paths }),
      workerId: 'ip-policy-rerun-worker'
    });

    await coordinator.submit(rerun.id);

    expect(gatewayCalls).toBe(1);
    expect(fixture.repository.get(original.id)?.poyoTaskId).toBe('task-ip-policy-rerun');
    expect(fixture.repository.get(rerun.id)).toMatchObject({
      localPhase: 'requires_attention',
      attentionCode: 'public_ipv4_guard_match',
      retryOfJobId: original.id
    });
    expect(
      fixture.database
        .query<{ state: string; sent_at: string | null }, [string]>(
          'SELECT state,sent_at FROM submission_intents WHERE job_id=?'
        )
        .get(rerun.id)
    ).toEqual({ state: 'rejected', sent_at: null });
  });

  test('policy-blocked polling pauses automatic recovery and manual refresh can resume', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const job = accepted(fixture, 'ip-policy-poll');
    let polls = 0;
    const coordinator = new JobCoordinator({
      repository: fixture.repository,
      poyo: gateway({
        getStatus: async () => {
          polls += 1;
          if (polls === 1) {
            throw new PoyoError({
              category: 'policy',
              technicalCode: 'public_ipv4_guard_unavailable',
              message: 'Poyo was not contacted because public IPv4 verification failed.',
              retryable: false,
              operation: 'status'
            });
          }
          return {
            taskId: 'task-ip-policy-poll',
            statusRaw: 'running',
            status: 'running',
            creditsAmount: 1,
            files: [],
            createdTime: 'now',
            progress: 50,
            errorMessage: null
          };
        }
      }),
      downloader: new OutputDownloader({ repository: fixture.repository, paths: fixture.paths }),
      workerId: 'ip-policy-poll-worker'
    });
    await coordinator.poll(job.id);
    expect(fixture.repository.get(job.id)).toMatchObject({
      localPhase: 'requires_attention',
      attentionCode: 'public_ipv4_guard_unavailable',
      nextPollAt: null
    });
    await coordinator.recoverOnce();
    expect(polls).toBe(1);
    await coordinator.poll(job.id, true);
    expect(polls).toBe(2);
    expect(fixture.repository.get(job.id)).toMatchObject({
      localPhase: 'monitoring',
      remoteStatus: 'running',
      attentionCode: null
    });
  });

  test('JOB-01 serializes paid submissions FIFO and continues after an unknown outcome', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const first = createTestJob(fixture.repository, 'fifo-first');
    const second = createTestJob(fixture.repository, 'fifo-second');
    let releaseFirst = (): void => undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted = (): void => undefined;
    const firstEntered = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let secondStarted = (): void => undefined;
    const secondEntered = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    let releaseFirstBalance = (): void => undefined;
    const firstBalanceBlocked = new Promise<void>((resolve) => {
      releaseFirstBalance = resolve;
    });
    let balanceCalls = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    const order: string[] = [];
    const coordinator = new JobCoordinator({
      repository: fixture.repository,
      poyo: gateway({
        submit: async (request) => {
          const prompt = String(request.input.prompt);
          order.push(prompt);
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          try {
            if (prompt.includes('fifo-first')) {
              firstStarted();
              await firstBlocked;
              throw new PoyoError({
                category: 'network',
                technicalCode: 'fifo_socket_drop',
                message: 'uncertain',
                retryable: true,
                operation: 'submit'
              });
            }
            secondStarted();
            return {
              taskId: 'task-fifo-second',
              statusRaw: 'not_started',
              status: 'not_started',
              createdTime: 'now'
            };
          } finally {
            concurrent -= 1;
          }
        },
        getBalance: async () => {
          balanceCalls += 1;
          if (balanceCalls === 1) await firstBalanceBlocked;
          return { email: 'studio@example.test', creditsAmount: 100, fetchedAt: 'now' };
        }
      }),
      downloader: new OutputDownloader({ repository: fixture.repository, paths: fixture.paths }),
      workerId: 'fifo-worker'
    });

    const firstSubmit = coordinator.submit(first.id);
    const secondSubmit = coordinator.submit(second.id);
    await firstEntered;
    expect(fixture.repository.get(second.id)?.localPhase).toBe('submission_prepared');
    expect(order).toEqual(['calm coast fifo-first']);
    releaseFirst();
    await secondEntered;
    expect(order).toEqual(['calm coast fifo-first', 'calm coast fifo-second']);
    releaseFirstBalance();
    await Promise.all([firstSubmit, secondSubmit]);

    expect(maxConcurrent).toBe(1);
    expect(order).toEqual(['calm coast fifo-first', 'calm coast fifo-second']);
    expect(fixture.repository.get(first.id)).toMatchObject({
      localPhase: 'requires_attention',
      attentionCode: 'submission_unknown'
    });
    expect(fixture.repository.get(second.id)).toMatchObject({
      localPhase: 'monitoring',
      poyoTaskId: 'task-fifo-second'
    });
  });

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

  test('JOB-02 restart recovery finishes delayed remote output without a duplicate submit', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const job = accepted(fixture, 'restart-finished');
    fixture.setNow(new Date('2026-07-15T12:00:02.000Z'));
    let submits = 0;
    let polls = 0;
    let downloads = 0;
    const coordinator = new JobCoordinator({
      repository: fixture.repository,
      poyo: gateway({
        submit: async () => {
          submits += 1;
          throw new Error('Recovery must not submit an acknowledged job again.');
        },
        getStatus: async () => {
          polls += 1;
          return {
            taskId: 'task-restart-finished',
            statusRaw: 'finished',
            status: 'finished',
            creditsAmount: 3,
            files: [
              {
                url: 'https://media.example/restart.png',
                fileType: 'image',
                label: null,
                format: 'png',
                contentType: 'image/png',
                fileName: 'restart.png',
                fileSize: 8
              }
            ],
            createdTime: 'now',
            progress: 100,
            errorMessage: null
          };
        }
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
      workerId: 'restarted-worker'
    });

    await coordinator.recoverOnce();

    expect({ submits, polls, downloads }).toEqual({ submits: 0, polls: 1, downloads: 1 });
    expect(fixture.repository.get(job.id)).toMatchObject({
      localPhase: 'complete',
      remoteStatus: 'finished',
      actualCredits: 3
    });
    expect(fixture.repository.outputs(job.id)).toHaveLength(1);
    expect(fixture.repository.outputs(job.id)[0]?.downloadState).toBe('verified');
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

  test('JOB-04/05/06 poll failures do not fail generation and no-op progress is not retained', async () => {
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
    ).toEqual([60]);
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

  test('MEDIA-03 restart permits an explicit failed-download retry without resubmission', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const { job, output } = finishedOutput(fixture, 'restart-download-retry');
    let submits = 0;
    const failedDownloader = new OutputDownloader({
      repository: fixture.repository,
      paths: fixture.paths,
      resolveHost: publicDns,
      fetch: async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-type': 'image/png' }
        })
    });
    const original = new JobCoordinator({
      repository: fixture.repository,
      poyo: gateway(),
      downloader: failedDownloader,
      workerId: 'before-restart'
    });
    await original.downloadPending(job.id);
    expect(fixture.repository.get(job.id)).toMatchObject({
      localPhase: 'requires_attention',
      failureDomain: 'download',
      attentionCode: 'download_failed'
    });

    const restarted = new JobCoordinator({
      repository: fixture.repository,
      poyo: gateway({
        submit: async () => {
          submits += 1;
          throw new Error('A download retry must not create another paid submission.');
        }
      }),
      downloader: new OutputDownloader({
        repository: fixture.repository,
        paths: fixture.paths,
        resolveHost: publicDns,
        fetch: async () =>
          new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
            headers: { 'content-type': 'image/png' }
          })
      }),
      workerId: 'after-restart'
    });
    await restarted.retryDownload(output.id);

    expect(submits).toBe(0);
    expect(fixture.repository.get(job.id)).toMatchObject({
      localPhase: 'complete',
      remoteStatus: 'finished',
      failureDomain: 'none',
      attentionCode: null
    });
    expect(fixture.repository.output(output.id)?.downloadState).toBe('verified');
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

  test('JOB-15 a stale or duplicate status does not regress a locally complete job', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const job = accepted(fixture, 'stale-guard');
    const finishedStatus: PoyoStatusResult = {
      taskId: 'task-stale-guard',
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
    const coordinator = new JobCoordinator({
      repository: fixture.repository,
      poyo: gateway({ getStatus: async () => finishedStatus }),
      downloader: new OutputDownloader({
        repository: fixture.repository,
        paths: fixture.paths,
        resolveHost: publicDns,
        fetch: async () =>
          new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
            headers: { 'content-type': 'image/png' }
          })
      }),
      runtimeSettings: () => ({
        pollDelayMs: 2_000,
        staleAfterMs: 60_000,
        automaticDownloads: true
      })
    });

    await coordinator.poll(job.id, true);
    await coordinator.reconcile(job.id);
    const completed = fixture.repository.get(job.id);
    expect(completed?.localPhase).toBe('complete');
    const completedAt = completed?.completedAt ?? null;
    expect(completedAt).not.toBeNull();
    expect(completed?.actualCredits).toBe(4);

    // A late or duplicate observation (e.g. a manual refresh) must not move the job back to
    // downloading or overwrite its original completion timestamp.
    fixture.setNow(new Date('2027-01-01T00:00:00.000Z'));
    fixture.repository.applyStatus(job.id, finishedStatus, 1_000);
    const afterStale = fixture.repository.get(job.id);
    expect(afterStale?.localPhase).toBe('complete');
    expect(afterStale?.completedAt).toBe(completedAt);
    expect(
      fixture.repository.output(fixture.repository.outputs(job.id)[0]?.id ?? '')?.downloadState
    ).toBe('verified');

    // A late poll carrying a different credits_amount (e.g. 0 from a not-yet-charged mid-run
    // observation) must not overwrite the settled charge recorded at completion.
    fixture.repository.applyStatus(job.id, { ...finishedStatus, creditsAmount: 0 }, 1_000);
    expect(fixture.repository.get(job.id)?.actualCredits).toBe(4);
  });

  test('JOB-15 the first terminal observation wins over late running and conflicting terminal responses', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const job = accepted(fixture, 'terminal-first-wins');
    fixture.repository.applyStatus(
      job.id,
      {
        taskId: 'task-terminal-first-wins',
        statusRaw: 'failed',
        status: 'failed',
        creditsAmount: 2,
        files: [],
        createdTime: 'now',
        progress: 55,
        errorMessage: 'safe remote failure'
      },
      1_000
    );
    const terminal = fixture.repository.get(job.id);
    expect(terminal).toMatchObject({
      localPhase: 'complete',
      remoteStatusRaw: 'failed',
      remoteStatus: 'failed',
      failureDomain: 'remote_generation',
      progress: 55,
      actualCredits: 2,
      nextPollAt: null
    });

    fixture.setNow(new Date('2026-07-15T12:01:00.000Z'));
    fixture.repository.applyStatus(
      job.id,
      {
        taskId: 'task-terminal-first-wins',
        statusRaw: 'running',
        status: 'running',
        creditsAmount: 0,
        files: [],
        createdTime: 'now',
        progress: 90,
        errorMessage: null
      },
      1_000
    );
    let downloads = 0;
    const coordinator = new JobCoordinator({
      repository: fixture.repository,
      poyo: gateway({
        getStatus: async () => ({
          taskId: 'task-terminal-first-wins',
          statusRaw: 'finished',
          status: 'finished',
          creditsAmount: 9,
          files: [
            {
              url: 'https://media.example/late.png',
              fileType: 'image',
              label: null,
              format: 'png',
              contentType: 'image/png',
              fileName: 'late.png',
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
          return new Response();
        }
      }),
      workerId: 'late-terminal-poller'
    });
    await coordinator.poll(job.id, true);

    expect(fixture.repository.get(job.id)).toEqual(terminal);
    expect(fixture.repository.outputs(job.id)).toEqual([]);
    expect(downloads).toBe(0);
  });

  test('JOB-15 poll failure after local completion is audit-only', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const job = accepted(fixture, 'settled-poll-failure');
    const finishedStatus: PoyoStatusResult = {
      taskId: 'task-settled-poll-failure',
      statusRaw: 'finished',
      status: 'finished',
      creditsAmount: 4,
      files: [
        {
          url: 'https://media.example/settled.png',
          fileType: 'image',
          label: null,
          format: 'png',
          contentType: 'image/png',
          fileName: 'settled.png',
          fileSize: 8
        }
      ],
      createdTime: 'now',
      progress: 100,
      errorMessage: null
    };
    const completing = new JobCoordinator({
      repository: fixture.repository,
      poyo: gateway({ getStatus: async () => finishedStatus }),
      downloader: new OutputDownloader({
        repository: fixture.repository,
        paths: fixture.paths,
        resolveHost: publicDns,
        fetch: async () =>
          new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
            headers: { 'content-type': 'image/png' }
          })
      }),
      workerId: 'completing-worker'
    });
    await completing.poll(job.id, true);
    const settled = fixture.repository.get(job.id);
    const settledOutputs = fixture.repository.outputs(job.id);
    expect(settled?.localPhase).toBe('complete');

    fixture.setNow(new Date('2026-07-15T12:01:00.000Z'));
    const failing = new JobCoordinator({
      repository: fixture.repository,
      poyo: gateway({
        getStatus: async () => {
          throw new PoyoError({
            category: 'network',
            technicalCode: 'network_failure',
            message: 'offline',
            retryable: true,
            operation: 'status'
          });
        }
      }),
      downloader: new OutputDownloader({ repository: fixture.repository, paths: fixture.paths }),
      workerId: 'late-poller'
    });
    await failing.poll(job.id, true);

    expect(fixture.repository.get(job.id)).toEqual(settled);
    expect(fixture.repository.outputs(job.id)).toEqual(settledOutputs);
    const failureEvent = fixture.repository
      .eventsAfter(0)
      .filter((event) => event.eventType === 'poll.failed')
      .at(-1);
    expect(failureEvent).toMatchObject({
      localPhase: 'complete',
      remoteStatus: 'finished',
      failureDomain: 'none',
      payload: { code: 'network_failure' }
    });
  });

  test('JOB-14 renews a download lease before expiry while media work is active', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const { job, output } = finishedOutput(fixture, 'download-heartbeat');
    let started: (() => void) | undefined;
    let release: ((response: Response) => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const response = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const coordinator = new JobCoordinator({
      repository: fixture.repository,
      poyo: gateway(),
      downloader: new OutputDownloader({
        repository: fixture.repository,
        paths: fixture.paths,
        resolveHost: publicDns,
        fetch: async () => {
          started?.();
          return response;
        }
      }),
      workerId: 'lease-owner',
      workLeaseMs: 60
    });

    const download = coordinator.downloadPending(job.id);
    await fetchStarted;
    fixture.setNow(new Date('2026-07-15T12:00:00.040Z'));
    await Bun.sleep(30);
    fixture.setNow(new Date('2026-07-15T12:00:00.070Z'));
    expect(fixture.repository.claimWork('download', output.id, 'contender', 60)).toBeNull();
    release?.(
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
        headers: { 'content-type': 'image/png' }
      })
    );
    await download;
    expect(fixture.repository.output(output.id)?.downloadState).toBe('verified');
    expect(fixture.repository.get(job.id)?.localPhase).toBe('complete');
  });

  test('JOB-15 aborts mutation when an expired download lease is reclaimed', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const { job, output } = finishedOutput(fixture, 'download-lease-lost');
    let started: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const coordinator = new JobCoordinator({
      repository: fixture.repository,
      poyo: gateway(),
      downloader: new OutputDownloader({
        repository: fixture.repository,
        paths: fixture.paths,
        resolveHost: publicDns,
        fetch: async () => {
          started?.();
          return new Promise<Response>(() => undefined);
        }
      }),
      workerId: 'expired-owner',
      workLeaseMs: 60
    });

    const download = coordinator.downloadPending(job.id);
    await fetchStarted;
    fixture.setNow(new Date('2026-07-15T12:00:00.061Z'));
    const contender = fixture.repository.claimWork('download', output.id, 'contender', 60);
    expect(contender).not.toBeNull();
    await Bun.sleep(30);
    await download;

    expect(fixture.repository.output(output.id)?.downloadState).toBe('downloading');
    expect(fixture.repository.get(job.id)).toMatchObject({
      localPhase: 'downloading',
      failureDomain: 'none',
      attentionCode: null
    });
    expect(
      fixture.database
        .query<{ status: string }, [string]>(
          'SELECT status FROM download_attempts WHERE output_id=? ORDER BY attempt DESC LIMIT 1'
        )
        .get(output.id)?.status
    ).toBe('started');
    if (contender) expect(fixture.repository.releaseWork(contender)).toBe(true);
  });
});
