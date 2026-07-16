import { afterEach, describe, expect, test } from 'bun:test';
import { JobRequestError } from '../../../src/lib/server/jobs/create-request';
import { seedImageRegistry } from '../../../src/lib/server/registry/repository';
import { createJobFixture, createTestJob } from '../../helpers/job-fixture';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const retiredRerunMessage =
  'This Seedream 5 Pro job contains the retired n setting. Use Edit in studio to review current settings before creating a new paid job.';

function durableCounts(database: Parameters<typeof seedImageRegistry>[0]) {
  return Object.fromEntries(
    ['jobs', 'submission_intents', 'job_events'].map((table) => [
      table,
      database.query<{ count: number }, []>(`SELECT COUNT(*) count FROM ${table}`).get()?.count ?? 0
    ])
  );
}

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

  test('JOB-03 freezes and exactly replays a legacy ambiguous Seedream 5 Pro intent', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    seedImageRegistry(fixture.database);
    const guidedRequest = { prompt: 'Legacy ambiguous request', n: 6, resolution: '1K' };
    const normalizedPayload = {
      model: 'seedream-5.0-pro',
      input: { prompt: 'Legacy ambiguous request', n: 6, resolution: '1K', size: '1:1' }
    };
    const expertDiff = [
      { key: 'n', value: 6, status: 'unverified' },
      { key: 'future_parameter', value: { mode: 'kept' }, status: 'unverified' }
    ];
    const inputs = [
      {
        role: 'historical-reference',
        mediaKind: 'image' as const,
        source: 'remote' as const,
        url: 'https://assets.example/legacy.png',
        metadata: { name: 'legacy.png', source: 'history' }
      }
    ];
    const job = fixture.repository.create({
      actionId: crypto.randomUUID(),
      entryKey: 'seedream-5.0-pro:text-to-image',
      workflow: 'text-to-image',
      publicModelId: 'seedream-5.0-pro',
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
    const retry = fixture.repository.retryAmbiguous(job.id, retryActionId);
    const replay = fixture.repository.retryAmbiguous(job.id, retryActionId);
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

  test.each([
    ['seedream-5.0-pro', 'seedream-5.0-pro:text-to-image', 'guided'],
    ['seedream-5.0-pro', 'seedream-5.0-pro:text-to-image', 'payload'],
    ['seedream-5.0-pro', 'seedream-5.0-pro:text-to-image', 'expert'],
    ['seedream-5.0-pro-edit', 'seedream-5.0-pro-edit:image-edit', 'guided'],
    ['seedream-5.0-pro-edit', 'seedream-5.0-pro-edit:image-edit', 'payload'],
    ['seedream-5.0-pro-edit', 'seedream-5.0-pro-edit:image-edit', 'expert']
  ] as const)(
    'JOB-14 blocks %s %s stale %s-only n reruns without durable effects',
    async (publicModelId, entryKey, carrier) => {
      const fixture = await createJobFixture();
      cleanups.push(fixture.cleanup);
      seedImageRegistry(fixture.database);
      const guidedRequest = {
        prompt: 'Legacy rerun request',
        ...(carrier === 'guided' ? { n: 6 } : {})
      };
      const normalizedPayload = {
        model: publicModelId,
        input: {
          prompt: 'Legacy rerun request',
          size: '1:1',
          resolution: '2K',
          ...(carrier === 'payload' ? { n: 6 } : {})
        }
      };
      const expertDiff =
        carrier === 'expert'
          ? [{ key: 'n', value: 6, status: 'unverified' }]
          : [{ key: 'future_parameter', value: 'kept', status: 'unverified' }];
      if (carrier === 'guided') expect(guidedRequest.n).toBe(6);
      else expect(guidedRequest).not.toHaveProperty('n');
      if (carrier === 'payload') expect(normalizedPayload.input.n).toBe(6);
      else expect(normalizedPayload.input).not.toHaveProperty('n');
      expect(expertDiff.some((override) => override.key === 'n')).toBe(carrier === 'expert');

      const source = fixture.repository.create({
        actionId: crypto.randomUUID(),
        entryKey,
        workflow: entryKey.endsWith(':image-edit') ? 'image-edit' : 'text-to-image',
        publicModelId,
        guidedRequest,
        normalizedPayload,
        expertDiff
      });
      const beforeJob = fixture.repository.get(source.id);
      const beforeCounts = durableCounts(fixture.database);
      const rerunActionId = crypto.randomUUID();
      let error: unknown;
      try {
        fixture.repository.rerunAsNew(source.id, rerunActionId);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(JobRequestError);
      expect(error).toMatchObject({
        code: 'retired_input_requires_review',
        status: 409,
        message: retiredRerunMessage
      });
      expect(durableCounts(fixture.database)).toEqual(beforeCounts);
      expect(fixture.repository.get(source.id)).toEqual(beforeJob);
      expect(fixture.repository.getByActionId(rerunActionId)).toBeNull();
    }
  );

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
    const currentRerun = fixture.repository.rerunAsNew(current.id, crypto.randomUUID());
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
    const supportingRerun = fixture.repository.rerunAsNew(supporting.id, crypto.randomUUID());
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

  test('JOB-11 preserves a historical Seedream 5 Pro n output count', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    seedImageRegistry(fixture.database);
    const job = fixture.repository.create({
      actionId: crypto.randomUUID(),
      entryKey: 'seedream-5.0-pro:text-to-image',
      workflow: 'text-to-image',
      publicModelId: 'seedream-5.0-pro',
      guidedRequest: { prompt: 'Historical six-output request', n: 6 },
      normalizedPayload: {
        model: 'seedream-5.0-pro',
        input: { prompt: 'Historical six-output request', n: 6 }
      }
    });
    fixture.repository.applyStatus(
      job.id,
      {
        taskId: 'legacy-six-output-task',
        statusRaw: 'finished',
        status: 'finished',
        creditsAmount: 6,
        files: Array.from({ length: 6 }, (_, index) => ({
          url: `https://poyo.test/legacy-${index}.png`,
          fileType: 'image',
          label: null,
          format: null,
          contentType: 'image/png',
          fileName: `legacy-${index}.png`,
          fileSize: null
        })),
        createdTime: 'now',
        progress: 100,
        errorMessage: null
      },
      1000
    );
    expect(fixture.repository.get(job.id)).toMatchObject({
      localPhase: 'downloading',
      remoteStatus: 'finished',
      attentionCode: null
    });
    expect(fixture.repository.outputs(job.id)).toHaveLength(6);
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

  test('UPLOAD-04 persists a managed local source reference beside its remote upload URL', async () => {
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
          managedSourceId
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
  });
});
