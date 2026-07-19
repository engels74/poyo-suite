import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobFiltersDto, LibraryFiltersDto } from '../../../src/lib/features/library/contracts';
import { JOB_EVENT_METADATA_KEY } from '../../../src/lib/server/jobs/event-attention';
import { LibraryRepository } from '../../../src/lib/server/library/repository';
import { seedImageRegistry } from '../../../src/lib/server/registry/repository';
import { createJobFixture } from '../../helpers/job-fixture';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

const jobs: JobFiltersDto = {
  status: 'all',
  q: '',
  model: '',
  workflow: '',
  dateFrom: '',
  dateTo: '',
  cursor: ''
};
const library: LibraryFiltersDto = {
  q: '',
  mediaKind: '',
  model: '',
  provider: '',
  workflow: '',
  aspectRatio: '',
  status: 'all',
  favorite: false,
  tag: '',
  dateFrom: '',
  dateTo: '',
  cursor: '',
  view: 'grid'
};

async function completedGeneration(suffix: string, prompt = `calm coast ${suffix}`) {
  const fixture = await createJobFixture();
  cleanups.push(fixture.cleanup);
  seedImageRegistry(fixture.database);
  const job = fixture.repository.create({
    actionId: crypto.randomUUID(),
    entryKey: 'flux-schnell:text-to-image',
    workflow: 'text-to-image',
    publicModelId: 'flux-schnell',
    guidedRequest: { prompt, aspectRatio: '1:1' },
    normalizedPayload: { model: 'flux-schnell', input: { prompt } },
    prompt,
    correlationId: `correlation-${suffix}`
  });
  fixture.repository.applyStatus(
    job.id,
    {
      taskId: `task-${suffix}`,
      statusRaw: 'finished',
      status: 'finished',
      creditsAmount: 3,
      files: [
        {
          url: `https://cdn.poyo.test/${suffix}.png`,
          fileType: 'image',
          label: null,
          format: 'png',
          contentType: 'image/png',
          fileName: `${suffix}.png`,
          fileSize: 12
        }
      ],
      createdTime: 'now',
      progress: 100,
      errorMessage: null
    },
    1000
  );
  const output = fixture.repository.outputs(job.id)[0];
  if (!output) throw new Error('Expected a fixture output.');
  const localPath = join(fixture.paths.media, job.id, `${suffix}.png`);
  await mkdir(join(fixture.paths.media, job.id), { recursive: true });
  await writeFile(localPath, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  const attempt = fixture.repository.startDownload(output.id);
  fixture.repository.verifyDownload(output.id, attempt, {
    path: localPath,
    size: 4,
    checksum: 'checksum',
    signature: '89504e47',
    contentType: 'image/png',
    pixelWidth: 1080,
    pixelHeight: 1920,
    aspectRatio: '9:16'
  });
  fixture.repository.finishIfDownloaded(job.id);
  return { fixture, job, output, localPath };
}

describe('server-side jobs and grouped library repository', () => {
  test('keeps the poll failure domain authoritative without widening list DTOs', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    seedImageRegistry(fixture.database);
    const job = fixture.repository.create({
      actionId: crypto.randomUUID(),
      entryKey: 'flux-schnell:text-to-image',
      workflow: 'text-to-image',
      publicModelId: 'flux-schnell',
      guidedRequest: { prompt: 'poll-blocked fixture' },
      normalizedPayload: { model: 'flux-schnell', input: { prompt: 'poll-blocked fixture' } }
    });
    const claim = fixture.repository.claimSubmission(job.id, 'test', 1_000);
    if (!claim) throw new Error('Expected a submission claim.');
    expect(
      fixture.repository.acknowledgeSubmission(job.id, claim.token, {
        taskId: 'task-poll-blocked-fixture',
        statusRaw: 'not_started',
        status: 'not_started',
        createdTime: 'now'
      })
    ).toBe(true);
    fixture.repository.recordPollBlocked(job.id, 'public_ipv4_guard_unavailable');

    const item = new LibraryRepository(fixture.database).listJobs(
      { ...jobs, status: 'attention' },
      1
    ).items[0];
    expect(item).toMatchObject({
      failureDomain: 'poll',
      attentionCode: 'ip_guard_blocked',
      ipGuardReason: 'unavailable'
    });
    expect(item).not.toHaveProperty('poyoTaskId');
  });

  test('filters, paginates and groups outputs without exposing local paths', async () => {
    const fullPrompt = [
      'calm coast first with a complete persisted prompt',
      'A second line proves that prompt formatting survives the detail data path.',
      `Unbroken containment token: ${'cobalt'.repeat(120)}`
    ].join('\n');
    const { fixture, job } = await completedGeneration('first', fullPrompt);
    const repository = new LibraryRepository(fixture.database);
    const jobPage = repository.listJobs({ ...jobs, status: 'completed', q: 'coast' }, 1);
    expect(jobPage.total).toBe(1);
    expect(jobPage.items[0]).toMatchObject({
      id: job.id,
      displayName: 'Flux Schnell',
      outputCount: 1,
      verifiedOutputCount: 1,
      promptExcerpt: fullPrompt.slice(0, 220)
    });

    const mediaPage = repository.listLibrary({ ...library, mediaKind: 'image' }, 1);
    expect(mediaPage.total).toBe(1);
    expect(mediaPage.items[0]).toMatchObject({
      jobId: job.id,
      outputCount: 1,
      promptExcerpt: fullPrompt.slice(0, 220)
    });
    expect(mediaPage.items[0]?.representative).toMatchObject({
      mediaUrl: expect.stringMatching(/^\/api\/media\//),
      pixelWidth: 1080,
      pixelHeight: 1920
    });

    const detail = await repository.getJobDetail(job.id);
    expect(detail?.prompt).toBe(fullPrompt);
    expect(detail?.outputs[0]).toMatchObject({
      localAvailable: true,
      fileName: 'first.png',
      pixelWidth: 1080,
      pixelHeight: 1920,
      aspectRatio: '9:16'
    });
    expect(detail?.outputs[0]).not.toHaveProperty('localPath');
    expect(await repository.storageStatistics(fixture.paths)).toMatchObject({
      indexedBytes: 4,
      verifiedFiles: 1,
      missingOrDeletedFiles: 0
    });
  });

  test('persists grouping metadata and applies explicit local deletion consequences', async () => {
    const { fixture, job, output, localPath } = await completedGeneration('organize');
    const repository = new LibraryRepository(fixture.database);
    repository.setFavorite(job.id, true);
    repository.setPinned(job.id, true);
    expect(repository.replaceTags(job.id, ['Landscape', ' landscape ', 'Pinned'])).toEqual([
      'Pinned',
      'landscape'
    ]);
    expect(
      repository.listLibrary({ ...library, favorite: true, tag: 'landscape' }).items[0]
    ).toMatchObject({ favorite: true, pinned: true, tags: ['Pinned', 'landscape'] });

    fixture.database
      .query('UPDATE jobs SET attention_code=? WHERE id=?')
      .run('public_ipv4_guard_match', job.id);

    await repository.deleteOutput(job.id, output.id, 'file', fixture.paths);
    expect(await Bun.file(localPath).exists()).toBe(false);
    expect((await repository.getJobDetail(job.id))?.outputs[0]).toMatchObject({
      downloadState: 'deleted',
      localAvailable: false
    });
    const storedEvent = fixture.database
      .query<{ safe_payload_json: string }, [string, string]>(
        'SELECT safe_payload_json FROM job_events WHERE job_id=? AND event_type=?'
      )
      .get(job.id, 'output.local_file_removed');
    expect(JSON.parse(storedEvent?.safe_payload_json ?? '{}')).toEqual({
      outputId: output.id,
      [JOB_EVENT_METADATA_KEY]: {
        version: 1,
        attentionCode: 'public_ipv4_guard_match',
        payloadWasNull: false
      }
    });
    const outwardEvent = (await repository.getJobDetail(job.id))?.history.find(
      (event) => event.eventType === 'output.local_file_removed'
    );
    expect(outwardEvent?.payload).toEqual({ outputId: output.id });
    expect(JSON.stringify(outwardEvent)).not.toContain(JOB_EVENT_METADATA_KEY);
    expect(JSON.stringify(outwardEvent)).not.toContain('public_ipv4_guard_match');
  });

  test('refuses to mark an output deleted when its file is outside managed media storage', async () => {
    const { fixture, job, output, localPath } = await completedGeneration('orphan-guard');
    const repository = new LibraryRepository(fixture.database);
    const foreign = `${fixture.paths.media}-foreign`;
    const strandedPaths = { ...fixture.paths, media: foreign };
    await expect(repository.deleteOutput(job.id, output.id, 'file', strandedPaths)).rejects.toThrow(
      /managed media storage/
    );
    // Must not report success: the file stays and the DB row is left untouched (no false "deleted").
    expect(await Bun.file(localPath).exists()).toBe(true);
    expect((await repository.getJobDetail(job.id))?.outputs[0]).toMatchObject({
      downloadState: 'verified',
      localAvailable: true
    });
  });

  test('accounts managed sources once and exposes missing-file history without local paths', async () => {
    const { fixture, job } = await completedGeneration('managed-source');
    const sourceId = crypto.randomUUID();
    const relativePath = `2026-07/${sourceId}.png`;
    const localPath = join(fixture.paths.uploads, relativePath);
    await mkdir(join(fixture.paths.uploads, '2026-07'), { recursive: true });
    await writeFile(localPath, new Uint8Array(8).fill(1));
    fixture.database
      .query(
        `INSERT INTO managed_sources(id,original_name,media_kind,mime_type,byte_size,checksum,signature,relative_path,availability,created_at,last_verified_at)
         VALUES (?,?,?,?,?,?,?,?, 'available',?,?)`
      )
      .run(
        sourceId,
        'safe-source.png',
        'image',
        'image/png',
        8,
        'source-checksum',
        '89504e47',
        relativePath,
        '2026-07-15T12:00:00.000Z',
        '2026-07-15T12:00:00.000Z'
      );
    fixture.database
      .query(
        `INSERT INTO job_inputs(job_id,role,input_order,media_kind,upload_url,metadata_json,availability,managed_source_id)
         VALUES (?, 'source-image', 0, 'image', 'https://poyo.test/source.png', '{}', 'available', ?)`
      )
      .run(job.id, sourceId);
    const repository = new LibraryRepository(fixture.database);
    expect(await repository.storageStatistics(fixture.paths)).toMatchObject({
      indexedBytes: 12,
      verifiedFiles: 2,
      generatedBytes: 4,
      managedSourceBytes: 8,
      managedSourceFiles: 1,
      missingOrDeletedSources: 0
    });

    await unlink(localPath);
    expect(await repository.storageStatistics(fixture.paths)).toMatchObject({
      indexedBytes: 4,
      verifiedFiles: 1,
      missingOrDeletedFiles: 1,
      managedSourceBytes: 0,
      managedSourceFiles: 0,
      missingOrDeletedSources: 1
    });
    const detail = await repository.getJobDetail(job.id);
    expect(detail?.inputs[0]).toMatchObject({
      managedSourceId: sourceId,
      sourceKind: 'local',
      sourceLabel: 'safe-source.png',
      availability: 'missing',
      localConsequence: 'missing',
      byteSize: 8,
      checksum: 'source-checksum'
    });
    expect(detail?.inputs[0]).not.toHaveProperty('localPath');
  });

  test('history strips durable attention metadata and redacts raw policy codes', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    seedImageRegistry(fixture.database);
    const job = fixture.repository.create({
      actionId: crypto.randomUUID(),
      entryKey: 'flux-schnell:text-to-image',
      workflow: 'text-to-image',
      publicModelId: 'flux-schnell',
      guidedRequest: { prompt: 'safe event history' },
      normalizedPayload: { model: 'flux-schnell', input: { prompt: 'safe event history' } }
    });
    fixture.repository.transition(
      job.id,
      'requires_attention',
      'poll',
      'public_ipv4_guard_match',
      'poll.policy_blocked',
      { code: 'public_ipv4_guard_match', marker: 'retained' }
    );
    fixture.repository.transition(
      job.id,
      'requires_attention',
      'submission',
      'submission_unknown',
      'submission.unknown'
    );
    fixture.database
      .query(
        `INSERT INTO job_events(job_id,event_type,local_phase,remote_status_raw,remote_status,failure_domain,progress,safe_payload_json,observed_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        job.id,
        'malformed.metadata',
        'requires_attention',
        null,
        'unknown',
        'submission',
        null,
        JSON.stringify({
          marker: 'malformed',
          [JOB_EVENT_METADATA_KEY]: { version: 'invalid', payloadWasNull: false }
        }),
        '2026-07-15T12:00:01.000Z'
      );

    const history = (await new LibraryRepository(fixture.database).getJobDetail(job.id))?.history;
    expect(history?.find((event) => event.eventType === 'job.created')?.payload).toBeNull();
    expect(history?.find((event) => event.eventType === 'submission.unknown')?.payload).toBeNull();
    expect(history?.find((event) => event.eventType === 'poll.policy_blocked')?.payload).toEqual({
      marker: 'retained',
      policy: 'ip_guard_blocked',
      reason: 'match'
    });
    expect(history?.find((event) => event.eventType === 'malformed.metadata')?.payload).toEqual({
      marker: 'malformed'
    });
    expect(JSON.stringify(history)).not.toContain(JOB_EVENT_METADATA_KEY);
    expect(JSON.stringify(history)).not.toContain('public_ipv4_guard_match');
  });
});
