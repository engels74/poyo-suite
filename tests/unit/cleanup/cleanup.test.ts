import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REMOTE_CLEANUP_CAPABILITY } from '../../../src/lib/features/cleanup/contracts';
import { CleanupRepository } from '../../../src/lib/server/cleanup/repository';
import { CleanupRuntime } from '../../../src/lib/server/cleanup/runtime';
import { CleanupService } from '../../../src/lib/server/cleanup/service';
import { LibraryRepository } from '../../../src/lib/server/library/repository';
import { createJobFixture, createTestJob } from '../../helpers/job-fixture';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

async function fixture() {
  const setup = await createJobFixture(new Date('2026-07-15T12:00:00.000Z'));
  cleanups.push(setup.cleanup);
  await mkdir(setup.paths.media, { recursive: true });
  let order = 0;
  async function output(
    options: {
      favorite?: boolean;
      pinned?: boolean;
      tag?: string;
      ageDays?: number;
      bytes?: number;
      path?: string;
    } = {}
  ) {
    const job = createTestJob(setup.repository);
    const id = crypto.randomUUID();
    const path = options.path ?? join(setup.paths.media, `${id}.png`);
    const bytes = options.bytes ?? 4;
    await writeFile(path, new Uint8Array(bytes).fill(1));
    const createdAt = new Date(
      Date.parse('2026-07-15T12:00:00.000Z') - (options.ageDays ?? 100) * 86_400_000
    ).toISOString();
    setup.database
      .query(
        `INSERT INTO job_outputs(id,job_id,output_order,media_kind,local_path,content_type,byte_size,download_state,favorite,pinned,created_at,verified_at)
         VALUES (?,?,?,?,?,?,?,'verified',?,?,?,?)`
      )
      .run(
        id,
        job.id,
        order++,
        'image',
        path,
        'image/png',
        bytes,
        options.favorite ? 1 : 0,
        options.pinned ? 1 : 0,
        createdAt,
        createdAt
      );
    if (options.tag) new LibraryRepository(setup.database).replaceTags(job.id, [options.tag]);
    return { id, job, path, bytes };
  }
  return { ...setup, output };
}

describe('local cleanup policy, preview and durable execution', () => {
  test('CLEAN-01 defaults to never and age cleanup honors favorite, pin and tag exclusions', async () => {
    const setup = await fixture();
    const plain = await setup.output();
    await setup.output({ favorite: true });
    await setup.output({ pinned: true });
    await setup.output({ tag: 'keep' });
    const repository = new CleanupRepository(setup.database);
    const service = new CleanupService({ repository, paths: setup.paths });

    expect((await service.preview('file')).candidates).toHaveLength(0);
    service.setPolicy({
      mode: 'age',
      olderThanDays: 30,
      exclusions: { favorites: true, pinned: true, tags: ['KEEP'] }
    });
    const preview = await service.preview('file');
    expect(preview.candidates.map((entry) => entry.outputId)).toEqual([plain.id]);
    expect(preview.totalBytes).toBe(plain.bytes);
    expect(preview.candidates[0]?.reasons).toEqual(['age']);
    expect(() => service.apply(preview.token, false)).toThrow('confirmation');

    expect(service.apply(preview.token, true)).toEqual({ scheduled: 1, token: preview.token });
    const runtime = new CleanupRuntime({ repository, service, owner: 'worker-a' });
    expect(await runtime.runOnce()).toBe(1);
    expect(await Bun.file(plain.path).exists()).toBe(false);
    expect(setup.repository.output(plain.id)?.downloadState).toBe('deleted');
    expect(repository.actionCounts()).toEqual({ complete: 1 });
  });

  test('CLEAN-02 keeps file, metadata and both consequences distinct', async () => {
    for (const consequence of ['file', 'metadata', 'both'] as const) {
      const setup = await fixture();
      const item = await setup.output();
      const repository = new CleanupRepository(setup.database);
      const service = new CleanupService({ repository, paths: setup.paths });
      service.setPolicy({
        mode: 'age',
        olderThanDays: 1,
        exclusions: { favorites: true, pinned: true, tags: [] }
      });
      const preview = await service.preview(consequence);
      service.apply(preview.token, true);
      await new CleanupRuntime({ repository, service, owner: consequence }).runOnce();
      const exists = await Bun.file(item.path).exists();
      const metadata = setup.repository.output(item.id);
      expect(exists).toBe(consequence === 'metadata');
      if (consequence === 'file') expect(metadata?.downloadState).toBe('deleted');
      else expect(metadata).toBeNull();
    }
  });

  test('size and free-space policies select the oldest eligible bytes deterministically', async () => {
    const setup = await fixture();
    const oldest = await setup.output({ ageDays: 3, bytes: 6 });
    const newer = await setup.output({ ageDays: 2, bytes: 7 });
    const protectedOutput = await setup.output({ ageDays: 1, bytes: 20, favorite: true });
    const repository = new CleanupRepository(setup.database);
    const service = new CleanupService({
      repository,
      paths: setup.paths,
      storage: () => Promise.resolve({ freeBytes: 2 })
    });

    service.setPolicy({
      mode: 'total-size',
      maxBytes: 25,
      exclusions: { favorites: true, pinned: true, tags: [] }
    });
    expect((await service.preview('file')).candidates.map((entry) => entry.outputId)).toEqual([
      oldest.id,
      newer.id
    ]);

    service.setPolicy({
      mode: 'min-free-space',
      minFreeBytes: 8,
      exclusions: { favorites: true, pinned: true, tags: [] }
    });
    const preview = await service.preview('file');
    expect(preview.candidates.map((entry) => entry.outputId)).toEqual([oldest.id]);
    expect(preview.candidates).not.toContainEqual(
      expect.objectContaining({ outputId: protectedOutput.id })
    );
  });

  test('owner-token claims are exclusive and expired cleanup work is recovered after restart', async () => {
    const setup = await fixture();
    await setup.output();
    let current = new Date('2026-07-15T12:00:00.000Z');
    const repository = new CleanupRepository(setup.database, () => current);
    const service = new CleanupService({ repository, paths: setup.paths, now: () => current });
    service.setPolicy({
      mode: 'age',
      olderThanDays: 1,
      exclusions: { favorites: true, pinned: true, tags: [] }
    });
    const preview = await service.preview('file');
    service.apply(preview.token, true);
    const first = repository.claimNext('crashed-owner', 1000);
    expect(first).not.toBeNull();
    expect(repository.claimNext('competitor', 1000)).toBeNull();

    current = new Date('2026-07-15T12:00:02.000Z');
    expect(repository.reconcileExpiredClaims()).toBe(1);
    const recovered = repository.claimNext('restart-owner', 1000);
    expect(recovered?.attempt).toBe(2);
    if (!recovered) throw new Error('Expected cleanup claim recovery.');
    await service.execute(recovered);
    expect(repository.actionCounts()).toEqual({ complete: 1 });
  });

  test('rejects symlink deletion and never creates a remote cleanup schedule', async () => {
    const setup = await fixture();
    const outside = join(setup.paths.media, '..', 'outside.png');
    await writeFile(outside, new Uint8Array([1]));
    const link = join(setup.paths.media, 'linked.png');
    await symlink(outside, link);
    const item = await setup.output({ path: link, bytes: 1 });
    const repository = new CleanupRepository(setup.database);
    const service = new CleanupService({ repository, paths: setup.paths });
    service.setPolicy({
      mode: 'age',
      olderThanDays: 1,
      exclusions: { favorites: true, pinned: true, tags: [] }
    });
    const preview = await service.preview('file');
    service.apply(preview.token, true);
    await new CleanupRuntime({ repository, service, owner: 'safe-worker' }).runOnce();
    expect(await Bun.file(outside).exists()).toBe(true);
    expect(repository.actionCounts()).toEqual({ failed: 1 });
    expect(REMOTE_CLEANUP_CAPABILITY).toMatchObject({
      available: false,
      verifiedAt: '2026-07-15',
      documentedEndpoints: []
    });
    expect(
      setup.database
        .query<{ count: number }, [string]>(
          'SELECT COUNT(*) count FROM cleanup_actions WHERE target_id!=?'
        )
        .get(item.id)?.count
    ).toBe(0);
  });
});
