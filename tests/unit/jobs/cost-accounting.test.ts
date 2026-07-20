import { afterEach, describe, expect, test } from 'bun:test';
import {
  type EstimateEnvelope,
  PRICING_SIGNATURE_VERSION,
  type PublishedPricingSnapshot
} from '../../../src/lib/features/pricing/contracts';
import { buildPricingSignature } from '../../../src/lib/features/pricing/estimate';
import { IMAGE_REGISTRY_VERSION } from '../../../src/lib/features/registry/image-registry';
import { JobCoordinator, type JobPoyoGateway } from '../../../src/lib/server/jobs/coordinator';
import { OutputDownloader } from '../../../src/lib/server/jobs/downloader';
import type { JobRepository } from '../../../src/lib/server/jobs/repository';
import { estimateNormalizedRegistryRequest } from '../../../src/lib/server/pricing/estimate-request';
import { seedImageRegistry } from '../../../src/lib/server/registry/repository';
import { createJobFixture } from '../../helpers/job-fixture';

const cleanups: Array<() => Promise<void>> = [];
const registryVersion = IMAGE_REGISTRY_VERSION;
const signature = buildPricingSignature({
  registryVersion,
  modelId: 'seedream-5.0-pro',
  workflow: 'text-to-image',
  unit: 'per-output',
  dimensions: { quantity: 1 }
});
const pricingHash = 'a'.repeat(64);

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function envelope(credits = 8, hash = pricingHash): EstimateEnvelope {
  return {
    signatureVersion: PRICING_SIGNATURE_VERSION,
    signature,
    registryVersion,
    pricingHash: hash,
    basis: { unit: 'per-output', creditsPerUnit: credits, units: 1 },
    provenance: 'published',
    sourceVerifiedAt: '2026-07-20T00:00:00.000Z',
    credits
  };
}

function createPricedJob(
  repository: JobRepository,
  suffix: string,
  credits: number | null = 8,
  hash = pricingHash
) {
  return repository.create({
    actionId: crypto.randomUUID(),
    entryKey: 'seedream-5.0-pro:text-to-image',
    workflow: 'text-to-image',
    publicModelId: 'seedream-5.0-pro',
    guidedRequest: { prompt: `priced ${suffix}`, n: 1 },
    normalizedPayload: { model: 'seedream-5.0-pro', input: { prompt: `priced ${suffix}`, n: 1 } },
    estimatedCredits: credits,
    ...(credits === null ? {} : { estimateEnvelope: envelope(credits, hash) })
  });
}

function acknowledge(repository: JobRepository, jobId: string, suffix: string): void {
  const claim = repository.claimSubmission(jobId, 'cost-test', 10_000);
  if (!claim) throw new Error('Expected a submission claim.');
  expect(repository.markSubmissionTransmitted(jobId, claim.token)).toBe(true);
  expect(
    repository.acknowledgeSubmission(jobId, claim.token, {
      taskId: `task-${suffix}`,
      statusRaw: 'not_started',
      status: 'not_started',
      createdTime: '2026-07-20T00:00:00.000Z'
    })
  ).toBe(true);
}

function failTerminal(repository: JobRepository, jobId: string, suffix: string, credits: number) {
  return repository.applyStatus(
    jobId,
    {
      taskId: `task-${suffix}`,
      statusRaw: 'failed',
      status: 'failed',
      creditsAmount: credits,
      files: [],
      createdTime: '2026-07-20T00:00:00.000Z',
      progress: 100,
      errorMessage: 'provider failure'
    },
    1_000
  );
}

function snapshot(): PublishedPricingSnapshot {
  return {
    version: 1,
    signatureVersion: PRICING_SIGNATURE_VERSION,
    pricingHash,
    registryVersions: { image: registryVersion, video: 'video-2026-07-20.1' },
    source: {
      kind: 'published',
      url: 'https://poyo.ai/pricing',
      verifiedAt: '2026-07-20T00:00:00.000Z',
      expiresAt: '2026-07-21T00:00:00.000Z'
    },
    tiers: [
      {
        signature: buildPricingSignature({
          registryVersion,
          modelId: 'seedream-5.0-pro',
          workflow: 'text-to-image',
          unit: 'per-output'
        }),
        registryVersion,
        modelId: 'seedream-5.0-pro',
        mediaKind: 'image',
        workflow: 'text-to-image',
        dimensions: {},
        unit: 'per-output',
        creditsPerUnit: 8
      }
    ]
  };
}

describe('observed cost and outstanding accounting', () => {
  test('learns only bounded terminal task charges from an exact durable estimate group', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    seedImageRegistry(fixture.database);
    for (const [index, credits] of [4, 8, 6].entries()) {
      const job = createPricedJob(fixture.repository, `eligible-${index}`);
      acknowledge(fixture.repository, job.id, `eligible-${index}`);
      fixture.setNow(new Date(`2026-07-20T00:0${index + 1}:00.000Z`));
      failTerminal(fixture.repository, job.id, `eligible-${index}`, credits);
    }
    const staleGroup = createPricedJob(fixture.repository, 'other-hash', 8, 'b'.repeat(64));
    acknowledge(fixture.repository, staleGroup.id, 'other-hash');
    failTerminal(fixture.repository, staleGroup.id, 'other-hash', 100);
    const nonterminal = createPricedJob(fixture.repository, 'nonterminal');
    acknowledge(fixture.repository, nonterminal.id, 'nonterminal');
    fixture.repository.applyStatus(
      nonterminal.id,
      {
        taskId: 'task-nonterminal',
        statusRaw: 'running',
        status: 'running',
        creditsAmount: 999,
        files: [],
        createdTime: '2026-07-20T00:00:00.000Z',
        progress: 50,
        errorMessage: null
      },
      1_000
    );

    const estimate = estimateNormalizedRegistryRequest({
      snapshot: snapshot(),
      observations: fixture.repository,
      entryKey: 'seedream-5.0-pro:text-to-image',
      normalizedRequest: { model: 'seedream-5.0-pro', input: { prompt: 'next', n: 1 } },
      now: Date.parse('2026-07-20T12:00:00.000Z')
    });
    expect(estimate).toMatchObject({
      classification: 'estimate',
      credits: 6,
      provenance: 'observed',
      freshness: 'fresh',
      availability: 'available'
    });
    expect(
      fixture.repository.observedChargeSamples({
        signature,
        signatureVersion: PRICING_SIGNATURE_VERSION,
        registryVersion,
        pricingHash
      })
    ).toHaveLength(3);
  });

  test('samples matching balances around the first paid dispatch and terminal result', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    seedImageRegistry(fixture.database);
    const job = createPricedJob(fixture.repository, 'balance', 4);
    const timeouts: number[] = [];
    const balances = [100, 96];
    const poyo: JobPoyoGateway = {
      submit: async (_request, options) => {
        await options?.beforeDispatch?.();
        return {
          taskId: 'task-balance',
          statusRaw: 'not_started',
          status: 'not_started',
          createdTime: '2026-07-20T00:00:00.000Z'
        };
      },
      getStatus: async () => ({
        taskId: 'task-balance',
        statusRaw: 'failed',
        status: 'failed',
        creditsAmount: 4,
        files: [],
        createdTime: '2026-07-20T00:00:00.000Z',
        progress: 100,
        errorMessage: 'provider failure'
      }),
      getBalance: async (options) => {
        timeouts.push(options?.timeoutMs ?? 0);
        return {
          email: 'studio@example.test',
          creditsAmount: balances.shift() ?? 0,
          fetchedAt: new Date().toISOString()
        };
      }
    };
    const coordinator = new JobCoordinator({
      repository: fixture.repository,
      poyo,
      downloader: new OutputDownloader({ repository: fixture.repository, paths: fixture.paths }),
      workerId: 'cost-balance-worker'
    });

    await coordinator.submit(job.id);
    fixture.setNow(new Date('2026-07-20T00:01:00.000Z'));
    await coordinator.poll(job.id, true);

    expect(timeouts).toEqual([2_500, 2_500]);
    expect(fixture.repository.balanceCorroboration(job.id)).toEqual({
      status: 'corroborated',
      reason: null
    });
    expect(fixture.repository.taskCharge(job.id)).toMatchObject({
      classification: 'task-charge',
      credits: 4,
      source: 'poyo-task',
      terminalStatus: 'failed'
    });
    const sources = fixture.database
      .query<{ source: string }, []>('SELECT source FROM balance_snapshots ORDER BY id')
      .all()
      .map((row) => row.source);
    const actionId = fixture.repository.paidActionId(job.id);
    expect(sources).toEqual([
      `cost:v1:before:${job.id}:${actionId}`,
      `cost:v1:after:${job.id}:${actionId}`
    ]);
  });

  test('settles terminal-null actions and durably marks invalid balance samples ambiguous', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    seedImageRegistry(fixture.database);
    const job = createPricedJob(fixture.repository, 'terminal-null', 4);
    const poyo: JobPoyoGateway = {
      submit: async (_request, options) => {
        await options?.beforeDispatch?.();
        return {
          taskId: 'task-terminal-null',
          statusRaw: 'not_started',
          status: 'not_started',
          createdTime: '2026-07-20T00:00:00.000Z'
        };
      },
      getStatus: async () => ({
        taskId: 'task-terminal-null',
        statusRaw: 'cancelled',
        status: 'failed',
        creditsAmount: null,
        files: [],
        createdTime: '2026-07-20T00:00:00.000Z',
        progress: 100,
        errorMessage: 'cancelled'
      }),
      getBalance: async () => ({
        email: '',
        creditsAmount: 100,
        fetchedAt: '2026-07-20T00:00:00.000Z'
      })
    };
    const coordinator = new JobCoordinator({
      repository: fixture.repository,
      poyo,
      downloader: new OutputDownloader({ repository: fixture.repository, paths: fixture.paths }),
      workerId: 'cost-null-worker'
    });

    await coordinator.submit(job.id);
    await coordinator.poll(job.id, true);

    expect(fixture.repository.get(job.id)).toMatchObject({
      remoteStatusRaw: 'cancelled',
      remoteStatus: 'failed',
      actualCredits: null
    });
    expect(fixture.repository.taskCharge(job.id)).toBeNull();
    expect(fixture.repository.outstandingProjection()).toEqual({
      classification: 'estimate',
      credits: 0,
      actionCount: 0,
      availability: 'available'
    });
    expect(fixture.repository.balanceCorroboration(job.id)).toEqual({
      status: 'ambiguous',
      reason: 'snapshot_failed'
    });
    expect(
      fixture.database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) count FROM job_events WHERE event_type='balance.cost.failed'"
        )
        .get()?.count
    ).toBe(2);
  });

  test('projects every charge-risk action once and settles only on terminal remote truth', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    seedImageRegistry(fixture.database);
    const prepared = createPricedJob(fixture.repository, 'prepared', 1);
    const sending = createPricedJob(fixture.repository, 'sending', 2);
    expect(fixture.repository.claimSubmission(sending.id, 'worker', 10_000)).not.toBeNull();
    const running = createPricedJob(fixture.repository, 'running', 3);
    acknowledge(fixture.repository, running.id, 'running');
    fixture.repository.applyStatus(
      running.id,
      {
        taskId: 'task-running',
        statusRaw: 'running',
        status: 'running',
        creditsAmount: 0,
        files: [],
        createdTime: '2026-07-20T00:00:00.000Z',
        progress: 50,
        errorMessage: null
      },
      1_000
    );
    const unknown = createPricedJob(fixture.repository, 'unknown', 4);
    const unknownClaim = fixture.repository.claimSubmission(unknown.id, 'worker', 10_000);
    if (!unknownClaim) throw new Error('Expected unknown claim.');
    fixture.repository.markSubmissionTransmitted(unknown.id, unknownClaim.token);
    fixture.repository.markSubmissionUnknown(unknown.id, unknownClaim.token, 'socket_drop');
    const rejected = createPricedJob(fixture.repository, 'rejected', 100);
    const rejectedClaim = fixture.repository.claimSubmission(rejected.id, 'worker', 10_000);
    if (!rejectedClaim) throw new Error('Expected rejected claim.');
    fixture.repository.rejectUntransmittedPolicy(rejected.id, rejectedClaim.token, 'policy');
    const terminal = createPricedJob(fixture.repository, 'terminal', 100);
    acknowledge(fixture.repository, terminal.id, 'terminal');
    failTerminal(fixture.repository, terminal.id, 'terminal', 0);

    expect(fixture.repository.outstandingProjection()).toEqual({
      classification: 'estimate',
      credits: 10,
      actionCount: 4,
      availability: 'available'
    });

    const unavailable = createPricedJob(fixture.repository, 'unavailable', null);
    expect(fixture.repository.outstandingProjection()).toMatchObject({
      credits: null,
      actionCount: 5,
      availability: 'unavailable'
    });
    expect(prepared.localPhase).toBe('submission_prepared');
    fixture.database
      .query("UPDATE jobs SET remote_status='failed',actual_credits=NULL WHERE id=?")
      .run(unavailable.id);
    expect(fixture.repository.outstandingProjection()).toMatchObject({
      credits: 10,
      actionCount: 4,
      availability: 'available'
    });
  });
});
