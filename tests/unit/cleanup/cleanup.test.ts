import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REMOTE_CLEANUP_CAPABILITY } from '../../../src/lib/features/cleanup/contracts';
import { CleanupRepository } from '../../../src/lib/server/cleanup/repository';
import {
  CleanupRuntime,
  DEFAULT_CLEANUP_INTERVAL_MS
} from '../../../src/lib/server/cleanup/runtime';
import { CleanupService } from '../../../src/lib/server/cleanup/service';
import { LibraryRepository } from '../../../src/lib/server/library/repository';
import { createJobFixture, createTestJob } from '../../helpers/job-fixture';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

async function fixture() {
  const setup = await createJobFixture(new Date('2026-07-15T12:00:00.000Z'));
  cleanups.push(setup.cleanup);
  await Promise.all([
    mkdir(setup.paths.media, { recursive: true }),
    mkdir(setup.paths.uploads, { recursive: true })
  ]);
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
  async function source(options: { ageDays?: number; bytes?: number } = {}) {
    const id = crypto.randomUUID();
    const relativePath = `2026-01/${id}.png`;
    const path = join(setup.paths.uploads, relativePath);
    const bytes = options.bytes ?? 8;
    await mkdir(join(setup.paths.uploads, '2026-01'), { recursive: true });
    await writeFile(path, new Uint8Array(bytes).fill(1));
    const createdAt = new Date(
      Date.parse('2026-07-15T12:00:00.000Z') - (options.ageDays ?? 100) * 86_400_000
    ).toISOString();
    setup.database
      .query(
        `INSERT INTO managed_sources(id,original_name,media_kind,mime_type,byte_size,checksum,signature,relative_path,availability,created_at,last_verified_at)
         VALUES (?,?,?,?,?,?,?,?, 'available',?,?)`
      )
      .run(
        id,
        'source.png',
        'image',
        'image/png',
        bytes,
        'checksum',
        '89504e47',
        relativePath,
        createdAt,
        createdAt
      );
    return { id, path, relativePath, bytes };
  }
  return { ...setup, output, source };
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
        consequence,
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

  test('automatic cleanup remains disabled by default', async () => {
    const setup = await fixture();
    const item = await setup.output();
    const repository = new CleanupRepository(setup.database);
    const service = new CleanupService({ repository, paths: setup.paths });
    expect(service.policy()).toMatchObject({ mode: 'never', consequence: 'file' });

    expect(await new CleanupRuntime({ repository, service }).runOnce()).toBe(0);
    expect(await Bun.file(item.path).exists()).toBe(true);
    expect(repository.actionCounts()).toEqual({});
    expect(
      setup.database.query<{ enabled: number }, []>('SELECT enabled FROM cleanup_policies').get()
        ?.enabled
    ).toBe(0);
  });

  test('enabled policies are evaluated at startup and at the bounded periodic cadence', async () => {
    const setup = await fixture();
    const first = await setup.output();
    const repository = new CleanupRepository(setup.database);
    const service = new CleanupService({ repository, paths: setup.paths });
    service.setPolicy({
      mode: 'age',
      consequence: 'file',
      olderThanDays: 1,
      exclusions: { favorites: true, pinned: true, tags: [] }
    });
    let scheduledRun: (() => Promise<void>) | undefined;
    let scheduledEvery = 0;
    let cancellations = 0;
    const runtime = new CleanupRuntime({
      repository,
      service,
      schedule: (run, intervalMs) => {
        scheduledRun = run;
        scheduledEvery = intervalMs;
        return () => {
          cancellations += 1;
        };
      }
    });

    const stop = runtime.start();
    while (runtime.diagnostics().running) await Bun.sleep(0);
    expect(await Bun.file(first.path).exists()).toBe(false);
    const second = await setup.output();
    if (!scheduledRun) throw new Error('Expected a periodic cleanup callback.');
    await scheduledRun();
    expect(await Bun.file(second.path).exists()).toBe(false);
    expect(scheduledEvery).toBe(DEFAULT_CLEANUP_INTERVAL_MS);
    stop();
    expect(cancellations).toBe(1);
    expect(runtime.diagnostics().scheduled).toBe(false);

    let configuredEvery = 0;
    const configured = new CleanupRuntime({
      repository,
      service,
      intervalMs: 2 * 60_000,
      schedule: (_run, intervalMs) => {
        configuredEvery = intervalMs;
        return () => undefined;
      }
    });
    const stopConfigured = configured.start();
    while (configured.diagnostics().running) await Bun.sleep(0);
    stopConfigured();
    expect(configuredEvery).toBe(2 * 60_000);
  });

  test('restart reconciles an overdue automatic action and expired lease without duplication', async () => {
    const setup = await fixture();
    const item = await setup.output();
    let current = new Date('2026-07-15T12:00:00.000Z');
    const beforeRestart = new CleanupRepository(setup.database, () => current);
    const beforeService = new CleanupService({
      repository: beforeRestart,
      paths: setup.paths,
      now: () => current
    });
    beforeService.setPolicy({
      mode: 'age',
      consequence: 'file',
      olderThanDays: 1,
      exclusions: { favorites: true, pinned: true, tags: [] }
    });
    expect(await beforeService.scheduleEnabledPolicy()).toBe(1);
    expect(beforeRestart.claimNext('offline-worker', 1_000)).not.toBeNull();

    current = new Date('2026-07-15T12:00:02.000Z');
    const afterRestart = new CleanupRepository(setup.database, () => current);
    const afterService = new CleanupService({
      repository: afterRestart,
      paths: setup.paths,
      now: () => current
    });
    expect(
      await new CleanupRuntime({
        repository: afterRestart,
        service: afterService,
        owner: 'restart-worker'
      }).runOnce()
    ).toBe(1);
    expect(await Bun.file(item.path).exists()).toBe(false);
    expect(afterRestart.actionCounts()).toEqual({ complete: 1 });
    expect(
      setup.database
        .query<{ attempt: number }, []>('SELECT MAX(attempt) attempt FROM cleanup_attempts')
        .get()?.attempt
    ).toBe(2);
  });

  test('automatic evaluation preserves favorite, pinned and tag exclusions', async () => {
    const setup = await fixture();
    const plain = await setup.output();
    const lateFavorite = await setup.output();
    const favorite = await setup.output({ favorite: true });
    const pinned = await setup.output({ pinned: true });
    const tagged = await setup.output({ tag: 'archive' });
    const repository = new CleanupRepository(setup.database);
    const service = new CleanupService({ repository, paths: setup.paths });
    service.setPolicy({
      mode: 'age',
      consequence: 'file',
      olderThanDays: 1,
      exclusions: { favorites: true, pinned: true, tags: ['ARCHIVE'] }
    });
    expect(await service.scheduleEnabledPolicy()).toBe(2);
    setup.database.query('UPDATE job_outputs SET favorite=1 WHERE id=?').run(lateFavorite.id);

    expect(await new CleanupRuntime({ repository, service }).runOnce()).toBe(1);
    expect(await Bun.file(plain.path).exists()).toBe(false);
    for (const protectedItem of [lateFavorite, favorite, pinned, tagged]) {
      expect(await Bun.file(protectedItem.path).exists()).toBe(true);
    }
    expect(repository.actionCounts()).toEqual({ cancelled: 1, complete: 1 });
  });

  test('concurrent policy evaluation creates and executes one idempotent action', async () => {
    const setup = await fixture();
    await setup.output();
    const repositoryA = new CleanupRepository(setup.database);
    const repositoryB = new CleanupRepository(setup.database);
    let releaseRemoval: (() => void) | undefined;
    let removals = 0;
    const removeFile = async () => {
      removals += 1;
      await new Promise<void>((resolve) => {
        releaseRemoval = resolve;
      });
      return 'removed' as const;
    };
    const serviceA = new CleanupService({
      repository: repositoryA,
      paths: setup.paths,
      removeFile
    });
    const serviceB = new CleanupService({ repository: repositoryB, paths: setup.paths });
    serviceA.setPolicy({
      mode: 'age',
      consequence: 'file',
      olderThanDays: 1,
      exclusions: { favorites: true, pinned: true, tags: [] }
    });

    const firstRun = new CleanupRuntime({
      repository: repositoryA,
      service: serviceA,
      owner: 'scheduler-a'
    }).runOnce();
    while (removals === 0) await Bun.sleep(0);
    expect(
      await new CleanupRuntime({
        repository: repositoryB,
        service: serviceB,
        owner: 'scheduler-b'
      }).runOnce()
    ).toBe(0);
    releaseRemoval?.();
    expect(await firstRun).toBe(1);
    expect(removals).toBe(1);
    expect(repositoryA.actionCounts()).toEqual({ complete: 1 });
    expect(
      setup.database
        .query<{ count: number }, []>('SELECT COUNT(*) count FROM cleanup_actions')
        .get()?.count
    ).toBe(1);
  });

  test('planner failure is non-destructive and the next safe evaluation recovers', async () => {
    const setup = await fixture();
    const item = await setup.output();
    let measurable = false;
    const repository = new CleanupRepository(setup.database);
    const service = new CleanupService({
      repository,
      paths: setup.paths,
      storage: () => Promise.resolve({ freeBytes: measurable ? 0 : null })
    });
    service.setPolicy({
      mode: 'min-free-space',
      consequence: 'file',
      minFreeBytes: 1,
      exclusions: { favorites: true, pinned: true, tags: [] }
    });
    const runtime = new CleanupRuntime({ repository, service });

    expect(await runtime.runOnce()).toBe(0);
    expect(await Bun.file(item.path).exists()).toBe(true);
    expect(repository.actionCounts()).toEqual({});
    expect(runtime.diagnostics().lastError).toBe('CleanupValidationError');

    measurable = true;
    expect(await runtime.runOnce()).toBe(1);
    expect(await Bun.file(item.path).exists()).toBe(false);
    expect(runtime.diagnostics().lastError).toBeNull();
  });

  test('managed sources are shared, excluded while any referencing job is active, and retain history metadata', async () => {
    const setup = await fixture();
    const source = await setup.source();
    const createReference = (suffix: string) =>
      setup.repository.create({
        actionId: crypto.randomUUID(),
        workflow: 'image-to-image',
        publicModelId: 'provider/model',
        guidedRequest: { prompt: suffix },
        normalizedPayload: {
          model: 'provider/model',
          input: { prompt: suffix, image_url: 'https://poyo.test/source.png' }
        },
        inputs: [
          {
            role: 'source-image',
            mediaKind: 'image',
            source: 'uploaded',
            url: 'https://poyo.test/source.png',
            managedSourceId: source.id
          }
        ]
      });
    const first = createReference('first');
    const second = createReference('second');
    setup.database.query("UPDATE jobs SET local_phase='complete' WHERE id=?").run(first.id);
    const repository = new CleanupRepository(setup.database);
    const service = new CleanupService({ repository, paths: setup.paths });
    service.setPolicy({
      mode: 'age',
      consequence: 'file',
      olderThanDays: 1,
      exclusions: { favorites: true, pinned: true, tags: [] }
    });

    expect((await service.preview('file')).candidates).toHaveLength(0);
    setup.database.query("UPDATE jobs SET local_phase='complete' WHERE id=?").run(second.id);
    const preview = await service.preview('file');
    expect(preview.candidates).toEqual([
      expect.objectContaining({
        targetKind: 'managed-source',
        managedSourceId: source.id,
        outputId: null,
        jobIds: [first.id, second.id].toSorted()
      })
    ]);
    expect((await service.preview('metadata')).candidates).toHaveLength(0);
    service.apply(preview.token, true);
    expect(await new CleanupRuntime({ repository, service }).runOnce()).toBe(1);
    expect(await Bun.file(source.path).exists()).toBe(false);
    expect(
      setup.database
        .query<{ availability: string }, [string]>(
          'SELECT availability FROM managed_sources WHERE id=?'
        )
        .get(source.id)?.availability
    ).toBe('deleted');
    expect(
      setup.database
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) count FROM job_inputs WHERE managed_source_id=? AND availability='deleted'"
        )
        .get(source.id)?.count
    ).toBe(2);
  });

  test('managed source cleanup survives an expired claim without duplicate deletion', async () => {
    const setup = await fixture();
    const source = await setup.source();
    let current = new Date('2026-07-15T12:00:00.000Z');
    const before = new CleanupRepository(setup.database, () => current);
    const beforeService = new CleanupService({
      repository: before,
      paths: setup.paths,
      now: () => current
    });
    beforeService.setPolicy({
      mode: 'age',
      consequence: 'file',
      olderThanDays: 1,
      exclusions: { favorites: true, pinned: true, tags: [] }
    });
    expect(await beforeService.scheduleEnabledPolicy()).toBe(1);
    expect(before.claimNext('crashed-source-worker', 1_000)?.targetId).toBe(source.id);

    current = new Date('2026-07-15T12:00:02.000Z');
    const after = new CleanupRepository(setup.database, () => current);
    const afterService = new CleanupService({
      repository: after,
      paths: setup.paths,
      now: () => current
    });
    expect(
      await new CleanupRuntime({
        repository: after,
        service: afterService,
        owner: 'restart-source-worker'
      }).runOnce()
    ).toBe(1);
    expect(await Bun.file(source.path).exists()).toBe(false);
    expect(after.actionCounts()).toEqual({ complete: 1 });
    expect(
      setup.database
        .query<{ count: number }, []>('SELECT COUNT(*) count FROM cleanup_actions')
        .get()?.count
    ).toBe(1);
  });

  test('a new active reference cancels already scheduled managed source cleanup', async () => {
    const setup = await fixture();
    const source = await setup.source();
    const repository = new CleanupRepository(setup.database);
    const service = new CleanupService({ repository, paths: setup.paths });
    service.setPolicy({
      mode: 'age',
      consequence: 'file',
      olderThanDays: 1,
      exclusions: { favorites: true, pinned: true, tags: [] }
    });
    const preview = await service.preview('file');
    service.apply(preview.token, true);
    const active = setup.repository.create({
      actionId: crypto.randomUUID(),
      workflow: 'image-to-image',
      publicModelId: 'provider/model',
      guidedRequest: { prompt: 'active reference' },
      normalizedPayload: {
        model: 'provider/model',
        input: { prompt: 'active reference', image_url: 'https://poyo.test/source.png' }
      },
      inputs: [
        {
          role: 'source-image',
          mediaKind: 'image',
          source: 'uploaded',
          url: 'https://poyo.test/source.png',
          managedSourceId: source.id
        }
      ]
    });

    expect(await new CleanupRuntime({ repository, service }).runOnce()).toBe(0);
    expect(await Bun.file(source.path).exists()).toBe(true);
    expect(repository.actionCounts()).toEqual({ cancelled: 1 });

    setup.database.query("UPDATE jobs SET local_phase='complete' WHERE id=?").run(active.id);
    expect(await new CleanupRuntime({ repository, service }).runOnce()).toBe(1);
    expect(await Bun.file(source.path).exists()).toBe(false);
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
