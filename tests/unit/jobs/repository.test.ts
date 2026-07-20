import { afterEach, describe, expect, test } from 'bun:test';
import { PRICING_SIGNATURE_VERSION } from '../../../src/lib/features/pricing/contracts';
import { seedImageRegistry } from '../../../src/lib/server/registry/repository';
import type { CreateJobRequest } from '../../../src/lib/server/jobs/types';
import { createJobFixture, createTestJob } from '../../helpers/job-fixture';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const unexpectedManagedSourceRefresh = async (): Promise<{ id: string; url: string }> => {
  throw new Error('This fixture has no managed source to refresh.');
};

describe('durable job repository invariants', () => {
  test('JOB-01 keeps local, remote, and failure axes orthogonal with atomic transitions', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const job = createTestJob(fixture.repository, 'state');
    expect(job).toMatchObject({
      localPhase: 'submission_prepared',
      remoteStatus: 'unknown',
      failureDomain: 'none'
    });
    expect(() => fixture.repository.transition(job.id, 'complete')).toThrow(
      'Invalid job transition'
    );
    expect(fixture.repository.get(job.id)?.localPhase).toBe('submission_prepared');
    expect(fixture.repository.get(job.id)?.normalizedPayload).toEqual(job.normalizedPayload);
  });

  test('JOB-01B records only meaningful Poyo status changes while advancing the poll clock', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const job = createTestJob(fixture.repository, 'deduplicated-status');
    const status = {
      taskId: 'task-deduplicated-status',
      statusRaw: 'running',
      status: 'running' as const,
      creditsAmount: 2,
      files: [],
      createdTime: 'now',
      progress: 0,
      errorMessage: null
    };

    fixture.setNow(new Date('2026-07-15T12:00:10Z'));
    const first = fixture.repository.applyStatus(job.id, status, 10_000);
    const statusEventCount = () =>
      fixture.database
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) count FROM job_events WHERE job_id=? AND event_type='status.observed'"
        )
        .get(job.id)?.count ?? 0;
    expect(statusEventCount()).toBe(1);

    fixture.setNow(new Date('2026-07-15T12:00:20Z'));
    const repeated = fixture.repository.applyStatus(job.id, status, 10_000);

    expect(statusEventCount()).toBe(1);
    expect(repeated.updatedAt).toBe(first.updatedAt);
    expect(repeated.lastPolledAt).toBe('2026-07-15T12:00:20.000Z');
    expect(repeated.nextPollAt).toBe('2026-07-15T12:00:30.000Z');
  });

  test('JOB-02 and DB-05 grant one one-way paid claim to competing reconcilers', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const job = createTestJob(fixture.repository, 'claim');
    const claims = await Promise.all([
      Promise.resolve(fixture.repository.claimSubmission(job.id, 'worker-a', 60_000)),
      Promise.resolve(fixture.repository.claimSubmission(job.id, 'worker-b', 60_000))
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(fixture.repository.get(job.id)?.localPhase).toBe('submitting');
  });

  test('JOB-02 permits a deliberate new job with identical settings without sharing its intent', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const request = {
      actionId: '019b0000-0000-7000-8000-000000000101',
      workflow: 'text-to-image',
      publicModelId: 'provider/model',
      guidedRequest: { prompt: 'same reviewed settings' },
      normalizedPayload: {
        model: 'provider/model',
        input: { prompt: 'same reviewed settings' }
      }
    };
    const first = fixture.repository.create(request);
    const second = fixture.repository.create({
      ...request,
      actionId: '019b0000-0000-7000-8000-000000000102'
    });
    expect(second.id).not.toBe(first.id);
    expect(
      fixture.database
        .query<{ count: number }, []>('SELECT COUNT(*) count FROM submission_intents')
        .get()?.count
    ).toBe(2);
  });

  test('JOB-02 replays one stable paid action and rejects an altered immutable request', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const request = {
      actionId: '019b0000-0000-7000-8000-000000000103',
      workflow: 'text-to-image',
      publicModelId: 'provider/model',
      guidedRequest: { prompt: 'one reviewed action' },
      normalizedPayload: {
        model: 'provider/model',
        input: { prompt: 'one reviewed action' }
      },
      expectedMediaKind: 'image' as const,
      expectedOutputCount: 1
    };
    const first = fixture.repository.create(request);
    const replay = fixture.repository.create(request);
    expect(replay.id).toBe(first.id);
    expect(
      fixture.database
        .query<{ count: number }, []>('SELECT COUNT(*) count FROM submission_intents')
        .get()?.count
    ).toBe(1);
    expect(() =>
      fixture.repository.create({
        ...request,
        normalizedPayload: {
          model: 'provider/model',
          input: { prompt: 'altered after the first request' }
        }
      })
    ).toThrow('different immutable request');
  });

  test('persists one bounded safe estimate envelope with the created job', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    seedImageRegistry(fixture.database);
    const job = fixture.repository.create({
      actionId: '019b0000-0000-7000-8000-000000000105',
      entryKey: 'seedream-5.0-pro:text-to-image',
      workflow: 'text-to-image',
      publicModelId: 'seedream-5.0-pro',
      guidedRequest: { prompt: 'private prompt' },
      normalizedPayload: { model: 'seedream-5.0-pro', input: { prompt: 'private prompt', n: 2 } },
      estimatedCredits: 16,
      estimateEnvelope: {
        signatureVersion: PRICING_SIGNATURE_VERSION,
        signature:
          'version=pricing-signature-v1|registry=image-2026-07-20.1|model=seedream-5.0-pro|workflow=text-to-image|unit=per-output|quantity=2',
        registryVersion: 'image-2026-07-20.1',
        pricingHash: 'a'.repeat(64),
        basis: { unit: 'per-output', creditsPerUnit: 8, units: 2 },
        provenance: 'published',
        sourceVerifiedAt: '2026-07-20T00:00:00.000Z',
        credits: 16
      }
    });
    expect(job.estimatedCredits).toBe(16);
    const created = fixture.repository.eventsAfter(0).find((event) => event.jobId === job.id);
    expect(created?.payload).toEqual({
      estimate: {
        signatureVersion: PRICING_SIGNATURE_VERSION,
        signature:
          'version=pricing-signature-v1|registry=image-2026-07-20.1|model=seedream-5.0-pro|workflow=text-to-image|unit=per-output|quantity=2',
        registryVersion: 'image-2026-07-20.1',
        pricingHash: 'a'.repeat(64),
        basis: { unit: 'per-output', creditsPerUnit: 8, units: 2 },
        provenance: 'published',
        sourceVerifiedAt: '2026-07-20T00:00:00.000Z',
        credits: 16
      },
      __poyoStudioEvent: { version: 1, attentionCode: null, payloadWasNull: false }
    });
    expect(JSON.stringify(created?.payload)).not.toContain('private prompt');
  });

  test('excludes server-derived estimate provenance from paid-action identity', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const request = {
      actionId: '019b0000-0000-7000-8000-000000000106',
      workflow: 'text-to-image',
      publicModelId: 'provider/model',
      guidedRequest: { prompt: 'same paid intent' },
      normalizedPayload: { model: 'provider/model', input: { prompt: 'same paid intent' } },
      estimatedCredits: 8,
      estimateEnvelope: {
        signatureVersion: PRICING_SIGNATURE_VERSION,
        signature:
          'version=pricing-signature-v1|registry=fixture|model=provider%2Fmodel|workflow=text-to-image|unit=per-output|quantity=1',
        registryVersion: null,
        pricingHash: 'a'.repeat(64),
        basis: { unit: 'per-output' as const, creditsPerUnit: 8, units: 1 },
        provenance: 'published' as const,
        sourceVerifiedAt: '2026-07-20T00:00:00.000Z',
        credits: 8
      }
    } satisfies CreateJobRequest;
    const first = fixture.repository.create(request);
    const replay = fixture.repository.create({
      ...request,
      estimatedCredits: 9,
      estimateEnvelope: {
        ...request.estimateEnvelope,
        pricingHash: 'b'.repeat(64),
        basis: { unit: 'per-output', creditsPerUnit: 9, units: 1 },
        sourceVerifiedAt: '2026-07-21T00:00:00.000Z',
        credits: 9
      }
    });
    expect(replay.id).toBe(first.id);
    expect(replay.estimatedCredits).toBe(8);
    const created = fixture.repository
      .eventsAfter(0)
      .filter((event) => event.jobId === first.id && event.eventType === 'job.created');
    expect(created).toHaveLength(1);
    expect(created[0]?.payload).toMatchObject({
      estimate: { pricingHash: 'a'.repeat(64), credits: 8 }
    });
    expect(() =>
      fixture.repository.create({
        ...request,
        normalizedPayload: {
          model: 'provider/model',
          input: { prompt: 'a truly changed paid request' }
        },
        estimatedCredits: 9,
        estimateEnvelope: {
          ...request.estimateEnvelope,
          pricingHash: 'c'.repeat(64),
          basis: { unit: 'per-output', creditsPerUnit: 9, units: 1 },
          credits: 9
        }
      })
    ).toThrow('different immutable request');
  });

  test('rejects noncanonical estimate signatures before persistence', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    expect(() =>
      fixture.repository.create({
        actionId: '019b0000-0000-7000-8000-000000000107',
        workflow: 'text-to-image',
        publicModelId: 'provider/model',
        guidedRequest: { prompt: 'private paid request' },
        normalizedPayload: { model: 'provider/model', input: { prompt: 'private paid request' } },
        estimatedCredits: 8,
        estimateEnvelope: {
          signatureVersion: PRICING_SIGNATURE_VERSION,
          signature: 'prompt=private paid request',
          registryVersion: null,
          pricingHash: 'a'.repeat(64),
          basis: { unit: 'per-output', creditsPerUnit: 8, units: 1 },
          provenance: 'published',
          sourceVerifiedAt: '2026-07-20T00:00:00.000Z',
          credits: 8
        }
      })
    ).toThrow('Estimate envelope is invalid.');
    expect(
      fixture.database
        .query<{ count: number }, []>('SELECT COUNT(*) count FROM submission_intents')
        .get()?.count
    ).toBe(0);
  });

  test('JOB-03 freezes and exactly replays a current ambiguous paid intent', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    seedImageRegistry(fixture.database);
    const guidedRequest = {
      prompt: 'Ambiguous image-edit request',
      imageUrls: ['https://assets.example/reference.png'],
      resolution: '1K',
      aspectRatio: '1:1'
    };
    const normalizedPayload = {
      model: 'seedream-5.0-pro-edit',
      input: {
        prompt: 'Ambiguous image-edit request',
        image_urls: ['https://assets.example/reference.png'],
        resolution: '1K',
        size: '1:1'
      }
    };
    const expertDiff = [{ key: 'future_parameter', value: { mode: 'kept' }, status: 'unverified' }];
    const inputs = [
      {
        role: 'reference',
        mediaKind: 'image' as const,
        source: 'remote' as const,
        url: 'https://assets.example/reference.png',
        metadata: { name: 'reference.png', source: 'request' }
      }
    ];
    const job = fixture.repository.create({
      actionId: crypto.randomUUID(),
      entryKey: 'seedream-5.0-pro-edit:image-edit',
      workflow: 'image-edit',
      publicModelId: 'seedream-5.0-pro-edit',
      guidedRequest,
      normalizedPayload,
      expertDiff,
      inputs
    });
    const claim = fixture.repository.claimSubmission(job.id, 'worker', 1000);
    if (!claim) throw new Error('claim missing');
    fixture.repository.markSubmissionTransmitted(job.id, claim.token);
    fixture.setNow(new Date('2026-07-15T12:00:02Z'));
    expect(fixture.repository.claimSubmission(job.id, 'worker-2', 1000)).toBeNull();
    expect(fixture.repository.get(job.id)).toMatchObject({
      localPhase: 'requires_attention',
      attentionCode: 'submission_unknown',
      remoteStatus: 'unknown'
    });
    const sourceBeforeRetry = fixture.repository.get(job.id);
    const sourceInputs = fixture.database
      .query<
        {
          role: string;
          input_order: number;
          media_kind: string;
          source_url: string | null;
          upload_url: string | null;
          metadata_json: string;
        },
        [string]
      >(
        'SELECT role,input_order,media_kind,source_url,upload_url,metadata_json FROM job_inputs WHERE job_id=? ORDER BY input_order'
      )
      .all(job.id);
    const retryActionId = '019b0000-0000-7000-8000-000000000104';
    const retry = await fixture.repository.retryAmbiguous(
      job.id,
      retryActionId,
      unexpectedManagedSourceRefresh
    );
    const replay = await fixture.repository.retryAmbiguous(
      job.id,
      retryActionId,
      unexpectedManagedSourceRefresh
    );
    expect(retry.retryOfJobId).toBe(job.id);
    expect(retry.id).not.toBe(job.id);
    expect(replay.id).toBe(retry.id);
    expect(retry.guidedRequest).toEqual(guidedRequest);
    expect(retry.normalizedPayload).toEqual(normalizedPayload);
    expect(retry.expertDiff).toEqual(expertDiff);
    expect(
      fixture.database
        .query<
          {
            role: string;
            input_order: number;
            media_kind: string;
            source_url: string | null;
            upload_url: string | null;
            metadata_json: string;
          },
          [string]
        >(
          'SELECT role,input_order,media_kind,source_url,upload_url,metadata_json FROM job_inputs WHERE job_id=? ORDER BY input_order'
        )
        .all(retry.id)
    ).toEqual(sourceInputs);
    expect(fixture.repository.get(job.id)).toEqual(sourceBeforeRetry);
  });

  test('JOB-14 reruns current Pro jobs and non-Pro jobs with supported n', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    seedImageRegistry(fixture.database);
    const current = fixture.repository.create({
      actionId: crypto.randomUUID(),
      entryKey: 'seedream-5.0-pro:text-to-image',
      workflow: 'text-to-image',
      publicModelId: 'seedream-5.0-pro',
      guidedRequest: { prompt: 'Current Pro request' },
      normalizedPayload: {
        model: 'seedream-5.0-pro',
        input: { prompt: 'Current Pro request', size: '1:1', resolution: '2K' }
      }
    });
    const currentRerun = await fixture.repository.rerunAsNew(
      current.id,
      crypto.randomUUID(),
      unexpectedManagedSourceRefresh
    );
    expect(currentRerun.retryOfJobId).toBe(current.id);
    expect(currentRerun.guidedRequest).not.toHaveProperty('n');
    expect(currentRerun.normalizedPayload.input).not.toHaveProperty('n');

    const supporting = fixture.repository.create({
      actionId: crypto.randomUUID(),
      entryKey: 'flux-schnell:text-to-image',
      workflow: 'text-to-image',
      publicModelId: 'flux-schnell',
      guidedRequest: { prompt: 'Two outputs', n: 2 },
      normalizedPayload: { model: 'flux-schnell', input: { prompt: 'Two outputs', n: 2 } }
    });
    const supportingRerun = await fixture.repository.rerunAsNew(
      supporting.id,
      crypto.randomUUID(),
      unexpectedManagedSourceRefresh
    );
    expect(supportingRerun.guidedRequest.n).toBe(2);
    expect(supportingRerun.normalizedPayload.input.n).toBe(2);
  });

  test.each([
    ['zero outputs', 1, []],
    ['partial outputs', 2, [{ url: 'https://poyo.test/a.png', fileType: 'image' }]],
    [
      'duplicate outputs',
      2,
      [
        { url: 'https://poyo.test/output.png', fileType: 'image' },
        { url: 'https://poyo.test/output.png', fileType: 'image' }
      ]
    ],
    [
      'excess outputs',
      1,
      [
        { url: 'https://poyo.test/a.png', fileType: 'image' },
        { url: 'https://poyo.test/b.png', fileType: 'image' }
      ]
    ],
    ['unsupported audio', 1, [{ url: 'https://poyo.test/output.mp3', fileType: 'audio' }]],
    ['unknown media', 1, [{ url: 'https://poyo.test/output.bin', fileType: 'binary' }]]
  ])(
    'JOB-11 marks a finished task with %s as malformed instead of complete',
    async (_name, expectedOutputCount, files) => {
      const fixture = await createJobFixture();
      cleanups.push(fixture.cleanup);
      const job = fixture.repository.create({
        actionId: crypto.randomUUID(),
        workflow: 'text-to-image',
        publicModelId: 'provider/model',
        guidedRequest: { prompt: 'strict output set', n: expectedOutputCount },
        normalizedPayload: {
          model: 'provider/model',
          input: { prompt: 'strict output set', n: expectedOutputCount }
        },
        expectedMediaKind: 'image',
        expectedOutputCount
      });
      fixture.repository.applyStatus(
        job.id,
        {
          taskId: 'task-malformed',
          statusRaw: 'finished',
          status: 'finished',
          creditsAmount: 1,
          files: files.map((file, index) => ({
            ...file,
            label: null,
            format: null,
            contentType: null,
            fileName: `output-${index}`,
            fileSize: null
          })),
          createdTime: 'now',
          progress: null,
          errorMessage: null
        },
        1000
      );
      expect(fixture.repository.get(job.id)).toMatchObject({
        remoteStatus: 'finished',
        localPhase: 'requires_attention',
        failureDomain: 'remote_generation',
        attentionCode: 'malformed_output_set'
      });
      expect(fixture.repository.outputs(job.id)).toHaveLength(0);
    }
  );

  test('JOB-DIM retains verified dimensions when a later probe has no evidence', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const job = createTestJob(fixture.repository, 'verified-dimensions');
    fixture.repository.applyStatus(
      job.id,
      {
        taskId: 'verified-dimensions-task',
        statusRaw: 'finished',
        status: 'finished',
        creditsAmount: 1,
        files: [
          {
            url: 'https://poyo.test/verified-dimensions.png',
            fileType: 'image',
            label: null,
            format: 'png',
            contentType: 'image/png',
            fileName: 'verified-dimensions.png',
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
    if (!output) throw new Error('Output missing.');

    const firstAttempt = fixture.repository.startDownload(output.id);
    expect(firstAttempt).toBe(1);
    expect(
      fixture.repository.verifyDownload(output.id, firstAttempt, {
        path: '/tmp/verified-dimensions.png',
        size: 100,
        checksum: 'first-checksum',
        signature: '89504e47',
        contentType: 'image/png',
        pixelWidth: 1600,
        pixelHeight: 900,
        aspectRatio: '16:9'
      })
    ).toBe(true);
    expect(fixture.repository.output(output.id)).toMatchObject({
      downloadState: 'verified',
      contentType: 'image/png',
      pixelWidth: 1600,
      pixelHeight: 900,
      aspectRatio: '16:9'
    });

    const secondAttempt = fixture.repository.startDownload(output.id);
    expect(secondAttempt).toBe(2);
    expect(
      fixture.repository.verifyDownload(output.id, secondAttempt, {
        path: '/tmp/verified-dimensions.png',
        size: 100,
        checksum: 'second-checksum',
        signature: '89504e47',
        contentType: null,
        pixelWidth: null,
        pixelHeight: null,
        aspectRatio: null
      })
    ).toBe(true);
    expect(fixture.repository.output(output.id)).toMatchObject({
      downloadState: 'verified',
      contentType: 'image/png',
      pixelWidth: 1600,
      pixelHeight: 900,
      aspectRatio: '16:9'
    });
  });

  test('JOB-09 safely reclaims expired owner-token leases and rejects stale completion', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const first = fixture.repository.claimWork('poll', 'job-1', 'a', 1000);
    expect(first).not.toBeNull();
    expect(fixture.repository.claimWork('poll', 'job-1', 'b', 1000)).toBeNull();
    fixture.setNow(new Date('2026-07-15T12:00:02Z'));
    const second = fixture.repository.claimWork('poll', 'job-1', 'b', 1000);
    expect(second).toMatchObject({ owner: 'b', attempt: 2 });
    if (!first || !second) throw new Error('work claim missing');
    expect(fixture.repository.releaseWork(first)).toBe(false);
    expect(fixture.repository.releaseWork(second)).toBe(true);
    for (const type of ['download', 'cleanup'] as const) {
      const claim = fixture.repository.claimWork(type, `${type}-1`, 'worker', 1000);
      if (!claim) throw new Error('work claim missing');
      expect(fixture.repository.releaseWork(claim)).toBe(true);
    }
  });

  test('JOB-13 renews only the current unexpired owner-token lease', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const first = fixture.repository.claimWork('download', 'output-renew', 'a', 1_000);
    if (!first) throw new Error('work claim missing');
    fixture.setNow(new Date('2026-07-15T12:00:00.500Z'));
    const renewed = fixture.repository.renewWork(first, 1_000);
    expect(renewed).toMatchObject({ owner: 'a', token: first.token });
    fixture.setNow(new Date('2026-07-15T12:00:01.100Z'));
    expect(fixture.repository.claimWork('download', 'output-renew', 'b', 1_000)).toBeNull();
    fixture.setNow(new Date('2026-07-15T12:00:01.600Z'));
    const second = fixture.repository.claimWork('download', 'output-renew', 'b', 1_000);
    expect(second).toMatchObject({ owner: 'b', attempt: 2 });
    expect(fixture.repository.renewWork(first, 1_000)).toBeNull();
  });

  test('JOB-02 rejects credential-like payload fields before creating an intent', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    expect(() =>
      fixture.repository.create({
        actionId: crypto.randomUUID(),
        workflow: 'text-to-image',
        publicModelId: 'model',
        guidedRequest: {},
        normalizedPayload: { model: 'model', input: { api_key: 'forbidden' } }
      })
    ).toThrow('credential');
    expect(fixture.repository.list()).toHaveLength(0);
  });

  test('JOB-05 only an authoritative status response sets remote failed', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const job = createTestJob(fixture.repository, 'remote');
    const claim = fixture.repository.claimSubmission(job.id, 'worker', 1000);
    if (!claim) throw new Error('claim missing');
    fixture.repository.markSubmissionTransmitted(job.id, claim.token);
    fixture.repository.acknowledgeSubmission(job.id, claim.token, {
      taskId: 'task-1',
      statusRaw: 'not_started',
      status: 'not_started',
      createdTime: 'now'
    });
    fixture.repository.recordPollFailure(job.id, 'network_failure', true);
    expect(fixture.repository.get(job.id)?.remoteStatus).toBe('not_started');
    fixture.repository.applyStatus(
      job.id,
      {
        taskId: 'task-1',
        statusRaw: 'failed',
        status: 'failed',
        creditsAmount: 2,
        files: [],
        createdTime: 'now',
        progress: null,
        errorMessage: 'provider failed'
      },
      1000
    );
    expect(fixture.repository.get(job.id)).toMatchObject({
      remoteStatus: 'failed',
      failureDomain: 'remote_generation',
      localPhase: 'complete'
    });
  });

  test('JOB-05B refuses to record a poll policy block before a remote task is acknowledged', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const job = createTestJob(fixture.repository, 'poll-policy-without-task');

    expect(() =>
      fixture.repository.recordPollBlocked(job.id, 'public_ipv4_guard_unavailable')
    ).toThrow('acknowledged Poyo task');
    expect(fixture.repository.get(job.id)).toMatchObject({
      localPhase: 'submission_prepared',
      failureDomain: 'none',
      attentionCode: null,
      poyoTaskId: null
    });
  });

  test('UPLOAD-04 persists and refreshes a managed source before a paid rerun', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const managedSourceId = crypto.randomUUID();
    fixture.database
      .query(
        `INSERT INTO managed_sources(id,original_name,media_kind,mime_type,byte_size,checksum,signature,relative_path,availability,created_at,last_verified_at)
         VALUES (?,?,?,?,?,?,?,?, 'available',?,?)`
      )
      .run(
        managedSourceId,
        'source.png',
        'image',
        'image/png',
        8,
        'checksum',
        '89504e47',
        `2026-07/${managedSourceId}.png`,
        '2026-07-15T12:00:00.000Z',
        '2026-07-15T12:00:00.000Z'
      );
    const job = fixture.repository.create({
      actionId: crypto.randomUUID(),
      workflow: 'image-to-image',
      publicModelId: 'provider/model',
      guidedRequest: { prompt: 'reuse the retained source' },
      normalizedPayload: {
        model: 'provider/model',
        input: { prompt: 'reuse the retained source', image_url: 'https://poyo.test/source.png' }
      },
      inputs: [
        {
          role: 'source-image',
          mediaKind: 'image',
          source: 'uploaded',
          url: 'https://poyo.test/source.png',
          managedSourceId,
          metadata: { expiresAt: '2026-07-15T12:01:00.000Z' }
        }
      ]
    });
    expect(
      fixture.database
        .query<
          {
            managed_source_id: string | null;
            local_reference: string | null;
            upload_url: string | null;
          },
          [string]
        >('SELECT managed_source_id,local_reference,upload_url FROM job_inputs WHERE job_id=?')
        .get(job.id)
    ).toEqual({
      managed_source_id: managedSourceId,
      local_reference: null,
      upload_url: 'https://poyo.test/source.png'
    });
    let refreshes = 0;
    const actionId = crypto.randomUUID();
    const rerun = await fixture.repository.rerunAsNew(job.id, actionId, async (id, mediaKind) => {
      refreshes += 1;
      expect({ id, mediaKind }).toEqual({ id: managedSourceId, mediaKind: 'image' });
      return { id, url: 'https://poyo.test/refreshed-source.png' };
    });
    expect(rerun.normalizedPayload.input.image_url).toBe('https://poyo.test/refreshed-source.png');
    expect(
      fixture.database
        .query<{ managed_source_id: string | null; upload_url: string | null }, [string]>(
          'SELECT managed_source_id,upload_url FROM job_inputs WHERE job_id=?'
        )
        .get(rerun.id)
    ).toEqual({
      managed_source_id: managedSourceId,
      upload_url: 'https://poyo.test/refreshed-source.png'
    });
    const replay = await fixture.repository.rerunAsNew(job.id, actionId, async () => {
      throw new Error('An idempotent replay must not upload the source again.');
    });
    expect(replay.id).toBe(rerun.id);
    expect(refreshes).toBe(1);
  });
});
