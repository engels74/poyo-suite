import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobFiltersDto, LibraryFiltersDto } from '../../../src/lib/features/library/contracts';
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

async function completedGeneration(suffix: string) {
  const fixture = await createJobFixture();
  cleanups.push(fixture.cleanup);
  seedImageRegistry(fixture.database);
  const job = fixture.repository.create({
    actionId: crypto.randomUUID(),
    entryKey: 'flux-schnell:text-to-image',
    workflow: 'text-to-image',
    publicModelId: 'flux-schnell',
    guidedRequest: { prompt: `calm coast ${suffix}`, aspectRatio: '1:1' },
    normalizedPayload: { model: 'flux-schnell', input: { prompt: `calm coast ${suffix}` } },
    prompt: `calm coast ${suffix}`,
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
    contentType: 'image/png'
  });
  fixture.repository.finishIfDownloaded(job.id);
  return { fixture, job, output, localPath };
}

describe('server-side jobs and grouped library repository', () => {
  test('filters, paginates and groups outputs without exposing local paths', async () => {
    const { fixture, job } = await completedGeneration('first');
    const repository = new LibraryRepository(fixture.database);
    const jobPage = repository.listJobs({ ...jobs, status: 'completed', q: 'coast' }, 1);
    expect(jobPage.total).toBe(1);
    expect(jobPage.items[0]).toMatchObject({
      id: job.id,
      displayName: 'Flux Schnell',
      outputCount: 1,
      verifiedOutputCount: 1
    });

    const mediaPage = repository.listLibrary({ ...library, mediaKind: 'image' }, 1);
    expect(mediaPage.total).toBe(1);
    expect(mediaPage.items[0]).toMatchObject({ jobId: job.id, outputCount: 1 });
    expect(mediaPage.items[0]?.representative?.mediaUrl).toStartWith('/api/media/');

    const detail = await repository.getJobDetail(job.id);
    expect(detail?.outputs[0]).toMatchObject({ localAvailable: true, fileName: 'first.png' });
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

    await repository.deleteOutput(job.id, output.id, 'file', fixture.paths);
    expect(await Bun.file(localPath).exists()).toBe(false);
    expect((await repository.getJobDetail(job.id))?.outputs[0]).toMatchObject({
      downloadState: 'deleted',
      localAvailable: false
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
});
