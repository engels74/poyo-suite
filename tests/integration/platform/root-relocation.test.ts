import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { chmod, lstat, mkdir, readdir, rename, symlink, unlink } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import {
  type AppPaths,
  ensureAppPaths,
  resolveAppPathCandidates
} from '../../../src/lib/server/platform/app-paths';
import { openDatabase } from '../../../src/lib/server/platform/database';
import { MaintenanceGate } from '../../../src/lib/server/platform/maintenance-gate';
import {
  applyExternalDatabaseRebase,
  beginProvisionalActivation,
  completeStartupRelocation,
  type RelocationCheckpoint,
  ROOT_RELOCATION_MANIFEST_FILE,
  RootRelocationCoordinator,
  resolveStartupRelocation,
  rollbackProvisionalActivation
} from '../../../src/lib/server/platform/root-relocation';
import {
  createInitialProjectMarker,
  promoteInitialProjectMarker,
  ROOT_MARKER_FILE,
  readRootMarker,
  selectRootForStartup,
  writeRootMarker
} from '../../../src/lib/server/platform/root-selector';
import { createTemporaryDirectory } from '../../helpers/temporary-directory';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

interface RelocationFixture {
  paths: { project: AppPaths; platform: AppPaths };
  database: Awaited<ReturnType<typeof openDatabase>>;
  unknownFile: string;
  secretCanary: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function snapshotPaths(paths: readonly string[]) {
  return Promise.all(
    paths.map(async (path) => {
      try {
        const details = await lstat(path);
        const databaseSidecar = /-(?:wal|shm|journal)$/.test(path);
        const bytes =
          details.isFile() && !details.isSymbolicLink()
            ? new Uint8Array(await Bun.file(path).arrayBuffer())
            : null;
        if (databaseSidecar) return { path, exists: true, bytes };
        return {
          path,
          exists: true,
          directory: details.isDirectory(),
          regular: details.isFile(),
          symbolicLink: details.isSymbolicLink(),
          size: details.size,
          mode: details.mode,
          mtimeMs: details.mtimeMs,
          ctimeMs: details.ctimeMs,
          bytes
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, exists: false };
        throw error;
      }
    })
  );
}

function dropCanonicalIndex(databasePath: string): void {
  const database = new Database(databasePath, { strict: true });
  try {
    database.exec('DROP INDEX idx_jobs_retry');
    database.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } finally {
    database.close();
  }
}

async function createFixture(): Promise<RelocationFixture> {
  const temporary = await createTemporaryDirectory('poyo-root-relocation-');
  cleanups.push(temporary.cleanup);
  const paths = resolveAppPathCandidates({
    environment: { HOME: join(temporary.path, 'home'), XDG_DATA_HOME: join(temporary.path, 'xdg') },
    platform: 'linux',
    projectRoot: join(temporary.path, 'repo')
  });
  await ensureAppPaths(paths.project);
  await mkdir(paths.project.secrets, { recursive: true, mode: 0o700 });
  const database = await openDatabase(paths.project.database);
  await writeRootMarker(
    paths.project.root,
    promoteInitialProjectMarker(createInitialProjectMarker())
  );
  const timestamp = '2026-07-17T00:00:00.000Z';
  database
    .query('INSERT INTO app_settings(key,value_version,value_json,updated_at) VALUES (?,?,?,?)')
    .run(
      'storage',
      1,
      JSON.stringify({
        outputDirectory: paths.project.media,
        previousRoots: [paths.project.media]
      }),
      timestamp
    );
  const unknownFile = join(paths.project.root, 'future-owned-entry.bin');
  const executableFile = join(paths.project.root, 'future-owned-tool');
  await Bun.write(unknownFile, 'future-compatible-root-data', { mode: 0o644 });
  await Bun.write(executableFile, 'future-compatible-root-tool', { mode: 0o755 });
  if (process.platform !== 'win32') {
    await chmod(unknownFile, 0o644);
    await chmod(executableFile, 0o755);
  }
  const secretCanary = 'relocation-secret-canary-value';
  await Bun.write(join(paths.project.secrets, 'credential'), secretCanary, { mode: 0o600 });
  return { paths, database, unknownFile, secretCanary };
}

async function createPreparedExternalDatabaseFixture() {
  const temporary = await createTemporaryDirectory('poyo-external-database-relocation-');
  cleanups.push(temporary.cleanup);
  const externalDatabase = join(temporary.path, 'external', 'studio.sqlite');
  const externalLogs = join(temporary.path, 'external-logs');
  const environment = {
    HOME: join(temporary.path, 'home'),
    XDG_DATA_HOME: join(temporary.path, 'xdg'),
    PLS_DATABASE_PATH: externalDatabase,
    PLS_LOG_DIR: externalLogs
  };
  const paths = resolveAppPathCandidates({
    environment,
    platform: 'linux',
    projectRoot: join(temporary.path, 'repo')
  });
  await ensureAppPaths(paths.project);
  const database = await openDatabase(externalDatabase);
  await writeRootMarker(
    paths.project.root,
    promoteInitialProjectMarker(createInitialProjectMarker())
  );
  database
    .query('INSERT INTO app_settings(key,value_version,value_json,updated_at) VALUES (?,?,?,?)')
    .run(
      'storage',
      1,
      JSON.stringify({ outputDirectory: paths.project.media, previousRoots: [] }),
      '2026-07-17T00:00:00.000Z'
    );
  const before = await lstat(externalDatabase);
  const externalLogCanary = join(externalLogs, 'operator-owned.log');
  await Bun.write(externalLogCanary, 'external log data must remain unchanged', { mode: 0o600 });
  const gate = new MaintenanceGate();
  await new RootRelocationCoordinator({
    source: paths.project,
    target: paths.platform,
    database,
    environment,
    gate,
    platform: 'linux'
  }).relocate(gate.acquireMaintenanceInitiator('external-database-relocation'));
  database.close();
  return {
    paths,
    environment,
    externalDatabase,
    externalLogs,
    externalLogCanary,
    before
  };
}

async function createPublishedExternalDatabaseFixture() {
  const prepared = await createPreparedExternalDatabaseFixture();
  const { paths, environment, externalDatabase } = prepared;
  const selection = await selectRootForStartup(paths.project, paths.platform);
  const context = await resolveStartupRelocation({ selection, candidates: paths, environment });
  await beginProvisionalActivation(context, environment);
  return {
    ...prepared,
    context,
    targetDatabase: await openDatabase(externalDatabase)
  };
}

async function relocate(
  fixture: RelocationFixture,
  options: { checkpoint?: (value: RelocationCheckpoint) => void | Promise<void> } = {}
) {
  const gate = new MaintenanceGate();
  const result = await new RootRelocationCoordinator({
    source: fixture.paths.project,
    target: fixture.paths.platform,
    database: fixture.database,
    environment: {},
    gate,
    platform: 'linux',
    ...(options.checkpoint ? { checkpoint: options.checkpoint } : {})
  }).relocate(gate.acquireMaintenanceInitiator('test-relocation'));
  return { gate, result };
}

async function provisionalContext(fixture: RelocationFixture) {
  const selection = await selectRootForStartup(fixture.paths.project, fixture.paths.platform);
  return resolveStartupRelocation({
    selection,
    candidates: fixture.paths,
    environment: {}
  });
}

async function cleanupOrder(targetRoot: string): Promise<string[]> {
  const manifest = (await Bun.file(join(targetRoot, ROOT_RELOCATION_MANIFEST_FILE)).json()) as {
    entries: Array<{ path: string }>;
    sourceDatabaseEntries: Array<{ path: string }>;
  };
  return [
    ...new Set([
      ...manifest.entries.map((entry) => entry.path),
      ...manifest.sourceDatabaseEntries.map((entry) => entry.path),
      ROOT_MARKER_FILE
    ])
  ].toSorted((left, right) => {
    const depth = right.split(sep).length - left.split(sep).length;
    return depth || left.localeCompare(right);
  });
}

function swapAtPreDestructiveBoundary(
  targetRoot: string,
  targetPath: string,
  swap: () => Promise<void>
): (checkpoint: string) => Promise<void> {
  let position = 0;
  return async (checkpoint) => {
    if (checkpoint !== 'source-entry-before-quarantine') return;
    const order = await cleanupOrder(targetRoot);
    const current = order[position++];
    if (current === targetPath) await swap();
  };
}

async function runUntilProcessExit(
  fixture: RelocationFixture,
  checkpoint: RelocationCheckpoint
): Promise<number> {
  fixture.database.close();
  const child = Bun.spawn(
    [
      process.execPath,
      'tests/helpers/root-relocation-child.ts',
      JSON.stringify({ source: fixture.paths.project, target: fixture.paths.platform, checkpoint })
    ],
    { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' }
  );
  return child.exited;
}

describe('complete-root relocation', () => {
  test('publishes an immutable target, activates it on restart, and deletes source last', async () => {
    const fixture = await createFixture();
    const { gate, result } = await relocate(fixture);
    expect(result).toMatchObject({ targetRootKind: 'platform', restartRequired: true });
    expect(gate.status().admission).toBe('frozen');
    expect(await readRootMarker(fixture.paths.project.root)).toMatchObject({
      status: 'valid',
      marker: { state: 'active-intent' }
    });
    expect(await readRootMarker(fixture.paths.platform.root)).toMatchObject({
      status: 'valid',
      marker: { state: 'prepared' }
    });
    expect(await Bun.file(join(fixture.paths.platform.root, 'future-owned-entry.bin')).text()).toBe(
      'future-compatible-root-data'
    );
    expect(await Bun.file(join(fixture.paths.platform.root, 'future-owned-tool')).text()).toBe(
      'future-compatible-root-tool'
    );
    if (process.platform !== 'win32') {
      expect(
        (await lstat(join(fixture.paths.platform.root, 'future-owned-entry.bin'))).mode & 0o777
      ).toBe(0o600);
      expect(
        (await lstat(join(fixture.paths.platform.root, 'future-owned-tool'))).mode & 0o777
      ).toBe(0o700);
    }
    const manifestText = await Bun.file(
      join(fixture.paths.platform.root, ROOT_RELOCATION_MANIFEST_FILE)
    ).text();
    const controlState = [
      manifestText,
      await Bun.file(join(fixture.paths.project.root, ROOT_MARKER_FILE)).text(),
      await Bun.file(join(fixture.paths.platform.root, ROOT_MARKER_FILE)).text()
    ].join('\n');
    expect(controlState).not.toContain(fixture.secretCanary);
    for (const algorithm of ['sha1', 'sha256', 'sha384', 'sha512'] as const) {
      expect(controlState).not.toContain(
        new Bun.CryptoHasher(algorithm).update(fixture.secretCanary).digest('hex')
      );
    }

    fixture.database.close();
    const context = await provisionalContext(fixture);
    expect(context.kind).toBe('provisional');
    await beginProvisionalActivation(context, {});
    const targetDatabase = await openDatabase(fixture.paths.platform.database);
    try {
      expect(await completeStartupRelocation(context, targetDatabase)).toEqual({
        cleanupPhase: 'complete'
      });
      const storage = targetDatabase
        .query<{ value_json: string }, []>(
          "SELECT value_json FROM app_settings WHERE key='storage'"
        )
        .get();
      expect(storage?.value_json).toContain(fixture.paths.platform.root);
      expect(storage?.value_json).not.toContain(fixture.paths.project.root);
    } finally {
      targetDatabase.close();
    }
    expect(await pathExists(fixture.paths.project.root)).toBe(false);
    expect(
      await Bun.file(join(fixture.paths.platform.root, ROOT_RELOCATION_MANIFEST_FILE)).exists()
    ).toBe(false);
    expect(await readRootMarker(fixture.paths.platform.root)).toMatchObject({
      status: 'valid',
      marker: { state: 'active', peerRootKind: null, rebasePhase: 'none' }
    });
  });

  test('releases the maintenance initiator when synchronous setup fails before upgrade', async () => {
    const fixture = await createFixture();
    const gate = new MaintenanceGate();
    const randomUUID = spyOn(crypto, 'randomUUID').mockImplementation(() => {
      throw new Error('injected UUID setup failure');
    });
    try {
      await expect(
        new RootRelocationCoordinator({
          source: fixture.paths.project,
          target: fixture.paths.platform,
          database: fixture.database,
          environment: {},
          gate,
          platform: 'linux'
        }).relocate(gate.acquireMaintenanceInitiator('setup-failure'))
      ).rejects.toThrow('injected UUID setup failure');
      expect(gate.status()).toMatchObject({ admission: 'open', activeWriters: 0 });
      const writer = gate.acquireWriter('after-setup-failure');
      writer.release();
    } finally {
      randomUUID.mockRestore();
      fixture.database.close();
    }
  });

  test('rejects a non-hex manifest file hash before provisional activation', async () => {
    const fixture = await createFixture();
    await relocate(fixture);
    fixture.database.close();
    const manifestPath = join(fixture.paths.platform.root, ROOT_RELOCATION_MANIFEST_FILE);
    const manifest = (await Bun.file(manifestPath).json()) as {
      entries: Array<{ kind: string; sensitive: boolean; sha256: string | null }>;
    };
    const entry = manifest.entries.find(
      (candidate) => candidate.kind === 'file' && !candidate.sensitive
    );
    if (!entry) throw new Error('Expected a non-sensitive manifest file.');
    entry.sha256 = 'z'.repeat(64);
    await Bun.write(manifestPath, `${JSON.stringify(manifest)}\n`);

    await expect(provisionalContext(fixture)).rejects.toMatchObject({ code: 'manifest_invalid' });
    expect(await readRootMarker(fixture.paths.project.root)).toMatchObject({
      status: 'valid',
      marker: { state: 'active-intent' }
    });
  });

  test.each([
    'exclusive-acquired',
    'stage-created',
    'files-copied',
    'database-snapshotted',
    'paths-rebased',
    'manifest-written',
    'prepared-marker-written',
    'source-intent-written'
  ] as const)('rolls back checkpoint failure before publication: %s', async (failedAt) => {
    const fixture = await createFixture();
    const gate = new MaintenanceGate();
    await expect(
      new RootRelocationCoordinator({
        source: fixture.paths.project,
        target: fixture.paths.platform,
        database: fixture.database,
        environment: {},
        gate,
        platform: 'linux',
        checkpoint: (checkpoint) => {
          if (checkpoint === failedAt) throw new Error(`crash:${checkpoint}`);
        }
      }).relocate(gate.acquireMaintenanceInitiator('checkpoint-failure'))
    ).rejects.toThrow(`crash:${failedAt}`);
    expect(gate.status().admission).toBe('open');
    expect(await readRootMarker(fixture.paths.project.root)).toMatchObject({
      status: 'valid',
      marker: { state: 'active', peerRootKind: null }
    });
    expect(await Bun.file(fixture.paths.platform.root).exists()).toBe(false);
    const targetParent = join(fixture.paths.platform.root, '..');
    const entries = (await pathExists(targetParent)) ? await readdir(targetParent) : [];
    expect(entries.some((entry) => entry.includes('.poyo-stage-'))).toBe(false);
    expect(await Bun.file(fixture.unknownFile).text()).toBe('future-compatible-root-data');
    fixture.database.close();
  });

  test.each(['target-published', 'target-parent-synced'] as const)(
    'freezes and requires restart after publication checkpoint failure: %s',
    async (failedAt) => {
      const fixture = await createFixture();
      const gate = new MaintenanceGate();
      await expect(
        new RootRelocationCoordinator({
          source: fixture.paths.project,
          target: fixture.paths.platform,
          database: fixture.database,
          environment: {},
          gate,
          platform: 'linux',
          checkpoint: (checkpoint) => {
            if (checkpoint === failedAt) throw new Error(`crash:${checkpoint}`);
          }
        }).relocate(gate.acquireMaintenanceInitiator('publication-failure'))
      ).rejects.toMatchObject({ code: 'restart_required' });
      expect(gate.status().admission).toBe('frozen');
      expect(await readRootMarker(fixture.paths.project.root)).toMatchObject({
        status: 'valid',
        marker: { state: 'active-intent' }
      });
      expect(await readRootMarker(fixture.paths.platform.root)).toMatchObject({
        status: 'valid',
        marker: { state: 'prepared' }
      });
      fixture.database.close();
    }
  );

  test('quarantines and retains an exact stage-directory swap instead of deleting it', async () => {
    const fixture = await createFixture();
    const gate = new MaintenanceGate();
    const parent = dirname(fixture.paths.platform.root);
    const retainedOwnedStage = join(parent, 'retained-owned-stage');
    let swappedCanary: string | null = null;
    await expect(
      new RootRelocationCoordinator({
        source: fixture.paths.project,
        target: fixture.paths.platform,
        database: fixture.database,
        environment: {},
        gate,
        platform: 'linux',
        checkpoint: async (checkpoint) => {
          if (checkpoint === 'source-intent-written') throw new Error('begin rollback');
          if (checkpoint !== 'stage-before-quarantine') return;
          const name = (await readdir(parent)).find(
            (entry) => entry.includes('.poyo-stage-') && !entry.includes('quarantine')
          );
          if (!name) throw new Error('Expected relocation stage.');
          const stage = join(parent, name);
          const owner = await Bun.file(join(stage, '.poyo-stage-owner.json')).text();
          await rename(stage, retainedOwnedStage);
          await mkdir(stage, { mode: 0o700 });
          await Bun.write(join(stage, '.poyo-stage-owner.json'), owner, { mode: 0o600 });
          swappedCanary = join(stage, 'unowned-canary.txt');
          await Bun.write(swappedCanary, 'must-survive', { mode: 0o600 });
        }
      }).relocate(gate.acquireMaintenanceInitiator('stage-directory-swap'))
    ).rejects.toMatchObject({ code: 'rollback_incomplete' });

    expect(gate.status().admission).toBe('frozen');
    expect(await pathExists(retainedOwnedStage)).toBe(true);
    const quarantine = (await readdir(parent)).find((entry) =>
      entry.includes('.poyo-stage-quarantine-')
    );
    expect(quarantine).toBeDefined();
    expect(await Bun.file(join(parent, quarantine ?? '', 'unowned-canary.txt')).text()).toBe(
      'must-survive'
    );
    expect(swappedCanary).not.toBeNull();
    expect(await readRootMarker(fixture.paths.project.root)).toMatchObject({
      status: 'valid',
      marker: { state: 'active-intent' }
    });
    fixture.database.close();
  });

  test.each(['symlink', 'directory'] as const)(
    'retains a stage whose owner file is replaced by a %s at rollback',
    async (replacement) => {
      const fixture = await createFixture();
      const gate = new MaintenanceGate();
      const parent = dirname(fixture.paths.platform.root);
      const outsideCanary = join(parent, 'outside-owner-canary.json');
      await Bun.write(outsideCanary, '{"outside":true}\n', { mode: 0o600 });
      await expect(
        new RootRelocationCoordinator({
          source: fixture.paths.project,
          target: fixture.paths.platform,
          database: fixture.database,
          environment: {},
          gate,
          platform: 'linux',
          checkpoint: async (checkpoint) => {
            if (checkpoint === 'source-intent-written') throw new Error('begin rollback');
            if (checkpoint !== 'stage-before-quarantine') return;
            const name = (await readdir(parent)).find(
              (entry) => entry.includes('.poyo-stage-') && !entry.includes('quarantine')
            );
            if (!name) throw new Error('Expected relocation stage.');
            const owner = join(parent, name, '.poyo-stage-owner.json');
            await unlink(owner);
            if (replacement === 'symlink') await symlink(outsideCanary, owner);
            else await mkdir(owner, { mode: 0o700 });
          }
        }).relocate(gate.acquireMaintenanceInitiator(`stage-owner-${replacement}`))
      ).rejects.toMatchObject({ code: 'rollback_incomplete' });

      expect(gate.status().admission).toBe('frozen');
      expect(await Bun.file(outsideCanary).text()).toBe('{"outside":true}\n');
      const quarantine = (await readdir(parent)).find((entry) =>
        entry.includes('.poyo-stage-quarantine-')
      );
      expect(quarantine).toBeDefined();
      const retainedOwner = await lstat(join(parent, quarantine ?? '', '.poyo-stage-owner.json'));
      expect(
        replacement === 'symlink' ? retainedOwner.isSymbolicLink() : retainedOwner.isDirectory()
      ).toBe(true);
      fixture.database.close();
    }
  );

  test('resumes owned stage rollback after interruption immediately after quarantine rename', async () => {
    const fixture = await createFixture();
    const gate = new MaintenanceGate();
    let interrupted = false;
    await expect(
      new RootRelocationCoordinator({
        source: fixture.paths.project,
        target: fixture.paths.platform,
        database: fixture.database,
        environment: {},
        gate,
        platform: 'linux',
        checkpoint: (checkpoint) => {
          if (checkpoint === 'source-intent-written') throw new Error('begin rollback');
          if (checkpoint === 'stage-quarantined' && !interrupted) {
            interrupted = true;
            throw new Error('crash after stage quarantine');
          }
        }
      }).relocate(gate.acquireMaintenanceInitiator('stage-quarantine-crash'))
    ).rejects.toMatchObject({ code: 'rollback_incomplete' });
    fixture.database.close();

    const selection = await selectRootForStartup(fixture.paths.project, fixture.paths.platform);
    const context = await resolveStartupRelocation({
      selection,
      candidates: fixture.paths,
      environment: {}
    });
    expect(context.kind).toBe('ordinary');
    expect(await readRootMarker(fixture.paths.project.root)).toMatchObject({
      status: 'valid',
      marker: { state: 'active' }
    });
    expect(
      (await readdir(dirname(fixture.paths.platform.root))).some((entry) =>
        entry.includes('.poyo-stage-quarantine-')
      )
    ).toBe(false);
  });

  test('recovers an owned unpublished stage after actual process termination', async () => {
    const fixture = await createFixture();
    expect(await runUntilProcessExit(fixture, 'source-intent-written')).toBe(79);
    expect(await readRootMarker(fixture.paths.project.root)).toMatchObject({
      status: 'valid',
      marker: { state: 'active-intent' }
    });
    const selection = await selectRootForStartup(fixture.paths.project, fixture.paths.platform);
    const context = await resolveStartupRelocation({
      selection,
      candidates: fixture.paths,
      environment: {}
    });
    expect(context.kind).toBe('ordinary');
    expect(await readRootMarker(fixture.paths.project.root)).toMatchObject({
      status: 'valid',
      marker: { state: 'active' }
    });
    expect(await pathExists(fixture.paths.platform.root)).toBe(false);
    const targetParent = join(fixture.paths.platform.root, '..');
    const entries = (await pathExists(targetParent)) ? await readdir(targetParent) : [];
    expect(entries.some((entry) => entry.includes('.poyo-stage-'))).toBe(false);
  });

  test('activates a published target after actual process termination', async () => {
    const fixture = await createFixture();
    expect(await runUntilProcessExit(fixture, 'target-published')).toBe(79);
    const context = await provisionalContext(fixture);
    await beginProvisionalActivation(context, {});
    const targetDatabase = await openDatabase(fixture.paths.platform.database);
    try {
      expect(await completeStartupRelocation(context, targetDatabase)).toEqual({
        cleanupPhase: 'complete'
      });
    } finally {
      targetDatabase.close();
    }
    expect(await pathExists(fixture.paths.project.root)).toBe(false);
    expect(await readRootMarker(fixture.paths.platform.root)).toMatchObject({
      status: 'valid',
      marker: { state: 'active' }
    });
  });

  test('rolls back provisional activation after target tampering', async () => {
    const fixture = await createFixture();
    await relocate(fixture);
    fixture.database.close();
    await Bun.write(join(fixture.paths.platform.root, 'future-owned-entry.bin'), 'tampered');
    const context = await provisionalContext(fixture);
    await expect(beginProvisionalActivation(context, {})).rejects.toMatchObject({
      code: 'manifest_mismatch'
    });
    await rollbackProvisionalActivation(context, null);
    expect(await readRootMarker(fixture.paths.project.root)).toMatchObject({
      status: 'valid',
      marker: { state: 'active' }
    });
    expect(await readRootMarker(fixture.paths.platform.root)).toMatchObject({
      status: 'valid',
      marker: { state: 'failed' }
    });
    expect(await Bun.file(fixture.unknownFile).text()).toBe('future-compatible-root-data');
  });

  test('rejects schema-only target tampering with unchanged row counts', async () => {
    const fixture = await createFixture();
    await relocate(fixture);
    fixture.database.close();
    const tampered = await openDatabase(fixture.paths.platform.database);
    const index = tampered
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name LIMIT 1"
      )
      .get()?.name;
    expect(index).toBeDefined();
    tampered.exec(`DROP INDEX "${index?.replaceAll('"', '""')}"`);
    tampered.close();

    await expect(provisionalContext(fixture)).rejects.toMatchObject({
      code: 'database_incompatible'
    });
    expect(await readRootMarker(fixture.paths.project.root)).toMatchObject({
      status: 'valid',
      marker: { state: 'active-intent' }
    });
    expect(await readRootMarker(fixture.paths.platform.root)).toMatchObject({
      status: 'valid',
      marker: { state: 'prepared' }
    });
  });

  test('rejects a non-canonical provisional external database before activating its marker', async () => {
    const fixture = await createPreparedExternalDatabaseFixture();
    dropCanonicalIndex(fixture.externalDatabase);
    const protectedPaths = [
      fixture.externalDatabase,
      `${fixture.externalDatabase}-wal`,
      `${fixture.externalDatabase}-shm`,
      `${fixture.externalDatabase}-journal`,
      fixture.paths.project.root,
      fixture.paths.platform.root,
      join(fixture.paths.project.root, ROOT_MARKER_FILE),
      join(fixture.paths.platform.root, ROOT_MARKER_FILE),
      join(fixture.paths.platform.root, ROOT_RELOCATION_MANIFEST_FILE),
      join(fixture.paths.platform.root, '.poyo-stage-owner.json'),
      fixture.externalLogs,
      fixture.externalLogCanary
    ];
    const before = await snapshotPaths(protectedPaths);

    await expect(
      selectRootForStartup(fixture.paths.project, fixture.paths.platform)
    ).rejects.toMatchObject({ code: 'database_incompatible' });

    expect(await snapshotPaths(protectedPaths)).toEqual(before);
    expect(await readRootMarker(fixture.paths.project.root)).toMatchObject({
      status: 'valid',
      marker: { state: 'active-intent' }
    });
    expect(await readRootMarker(fixture.paths.platform.root)).toMatchObject({
      status: 'valid',
      marker: { state: 'prepared' }
    });
  });

  test('repairs active/prepared intent and proceeds provisionally in the same startup', async () => {
    const fixture = await createFixture();
    await relocate(fixture);
    fixture.database.close();
    const sourceProbe = await readRootMarker(fixture.paths.project.root);
    if (sourceProbe.status !== 'valid') throw new Error('expected source marker');
    await writeRootMarker(fixture.paths.project.root, { ...sourceProbe.marker, state: 'active' });

    const selection = await selectRootForStartup(fixture.paths.project, fixture.paths.platform);
    expect(selection.decision).toMatchObject({ action: 'repair-source-intent' });
    const context = await resolveStartupRelocation({
      selection,
      candidates: fixture.paths,
      environment: {}
    });
    expect(context.kind).toBe('provisional');
    await beginProvisionalActivation(context, {});
    const targetDatabase = await openDatabase(fixture.paths.platform.database);
    try {
      expect(await completeStartupRelocation(context, targetDatabase)).toEqual({
        cleanupPhase: 'complete'
      });
    } finally {
      targetDatabase.close();
    }
    expect(await pathExists(fixture.paths.project.root)).toBe(false);
  });

  test('preflights a repaired provisional target before changing the source marker', async () => {
    const fixture = await createFixture();
    await relocate(fixture);
    fixture.database.close();
    const sourceProbe = await readRootMarker(fixture.paths.project.root);
    if (sourceProbe.status !== 'valid') throw new Error('expected source marker');
    await writeRootMarker(fixture.paths.project.root, { ...sourceProbe.marker, state: 'active' });
    dropCanonicalIndex(fixture.paths.platform.database);
    const protectedPaths = [
      fixture.paths.platform.database,
      `${fixture.paths.platform.database}-wal`,
      `${fixture.paths.platform.database}-shm`,
      `${fixture.paths.platform.database}-journal`,
      fixture.paths.project.root,
      fixture.paths.platform.root,
      join(fixture.paths.project.root, ROOT_MARKER_FILE),
      join(fixture.paths.platform.root, ROOT_MARKER_FILE),
      join(fixture.paths.platform.root, ROOT_RELOCATION_MANIFEST_FILE),
      join(fixture.paths.platform.root, '.poyo-stage-owner.json')
    ];
    const before = await snapshotPaths(protectedPaths);

    await expect(
      selectRootForStartup(fixture.paths.project, fixture.paths.platform)
    ).rejects.toMatchObject({ code: 'database_incompatible' });

    expect(await snapshotPaths(protectedPaths)).toEqual(before);
    expect(await readRootMarker(fixture.paths.project.root)).toMatchObject({
      status: 'valid',
      marker: { state: 'active' }
    });
    expect(await readRootMarker(fixture.paths.platform.root)).toMatchObject({
      status: 'valid',
      marker: { state: 'prepared' }
    });
  });

  test('rejects a persisted external-looking alias into the source before mutation', async () => {
    const fixture = await createFixture();
    const alias = join(fixture.paths.project.root, '..', 'media-alias');
    await symlink(fixture.paths.project.media, alias, 'dir');
    fixture.database
      .query("UPDATE app_settings SET value_json=? WHERE key='storage'")
      .run(JSON.stringify({ outputDirectory: alias, previousRoots: [] }));
    const gate = new MaintenanceGate();

    await expect(
      new RootRelocationCoordinator({
        source: fixture.paths.project,
        target: fixture.paths.platform,
        database: fixture.database,
        environment: {},
        gate,
        platform: 'linux'
      }).relocate(gate.acquireMaintenanceInitiator('persisted-alias'))
    ).rejects.toMatchObject({ code: 'environment_path_overlap' });
    expect(gate.status().admission).toBe('open');
    expect(await readRootMarker(fixture.paths.project.root)).toMatchObject({
      status: 'valid',
      marker: { state: 'active' }
    });
    expect(await pathExists(fixture.paths.platform.root)).toBe(false);
    fixture.database.close();
  });

  test('rejects provisional activation when a persisted external path changes identity', async () => {
    const fixture = await createFixture();
    const external = join(fixture.paths.project.root, '..', 'external-output');
    const retainedOriginal = join(fixture.paths.project.root, '..', 'external-output-original');
    await mkdir(external, { recursive: true });
    fixture.database
      .query("UPDATE app_settings SET value_json=? WHERE key='storage'")
      .run(JSON.stringify({ outputDirectory: external, previousRoots: [] }));
    await relocate(fixture);
    fixture.database.close();
    await rename(external, retainedOriginal);
    await mkdir(external);

    const context = await provisionalContext(fixture);
    await expect(beginProvisionalActivation(context, {})).rejects.toMatchObject({
      code: 'path_unverifiable'
    });
    await rollbackProvisionalActivation(context, null);
    expect(await readRootMarker(fixture.paths.project.root)).toMatchObject({
      status: 'valid',
      marker: { state: 'active' }
    });
    expect(await pathExists(retainedOriginal)).toBe(true);
  });

  test('retains the source duplicate when cleanup verification fails after target activation', async () => {
    const fixture = await createFixture();
    await relocate(fixture);
    fixture.database.close();
    const context = await provisionalContext(fixture);
    await beginProvisionalActivation(context, {});
    const targetDatabase = await openDatabase(fixture.paths.platform.database);
    try {
      await Bun.write(fixture.unknownFile, 'source-changed-before-cleanup');
      expect(await completeStartupRelocation(context, targetDatabase)).toEqual({
        cleanupPhase: 'source-retained'
      });
    } finally {
      targetDatabase.close();
    }
    expect(await pathExists(fixture.paths.project.root)).toBe(true);
    expect(await readRootMarker(fixture.paths.project.root)).toMatchObject({
      status: 'valid',
      marker: { state: 'cleanup-pending' }
    });
    expect(await readRootMarker(fixture.paths.platform.root)).toMatchObject({
      status: 'valid',
      marker: { state: 'active' }
    });
    expect((await lstat(fixture.paths.project.root)).isDirectory()).toBe(true);
  });

  test('rejects a non-canonical paired cleanup database without changing cleanup state', async () => {
    const fixture = await createFixture();
    await relocate(fixture);
    fixture.database.close();
    const context = await provisionalContext(fixture);
    await beginProvisionalActivation(context, {});
    const targetDatabase = await openDatabase(fixture.paths.platform.database);
    try {
      await expect(
        completeStartupRelocation(context, targetDatabase, {
          checkpoint: (checkpoint) => {
            if (checkpoint === 'source-cleanup-marked') throw new Error('stop before cleanup');
          }
        })
      ).rejects.toThrow('stop before cleanup');
    } finally {
      targetDatabase.close();
    }
    dropCanonicalIndex(fixture.paths.platform.database);
    const protectedPaths = [
      fixture.paths.platform.database,
      `${fixture.paths.platform.database}-wal`,
      `${fixture.paths.platform.database}-shm`,
      `${fixture.paths.platform.database}-journal`,
      fixture.paths.project.root,
      fixture.paths.platform.root,
      join(fixture.paths.project.root, ROOT_MARKER_FILE),
      join(fixture.paths.platform.root, ROOT_MARKER_FILE),
      join(fixture.paths.platform.root, ROOT_RELOCATION_MANIFEST_FILE),
      join(fixture.paths.platform.root, '.poyo-stage-owner.json'),
      fixture.unknownFile
    ];
    const before = await snapshotPaths(protectedPaths);

    await expect(
      selectRootForStartup(fixture.paths.project, fixture.paths.platform)
    ).rejects.toMatchObject({ code: 'database_incompatible' });

    expect(await snapshotPaths(protectedPaths)).toEqual(before);
    expect(await readRootMarker(fixture.paths.project.root)).toMatchObject({
      status: 'valid',
      marker: { state: 'cleanup-pending' }
    });
    expect(await readRootMarker(fixture.paths.platform.root)).toMatchObject({
      status: 'valid',
      marker: { state: 'active' }
    });
  });

  test('rejects a non-canonical lone-active cleanup database without finalizing its manifest', async () => {
    const fixture = await createFixture();
    await relocate(fixture);
    fixture.database.close();
    const context = await provisionalContext(fixture);
    await beginProvisionalActivation(context, {});
    const targetDatabase = await openDatabase(fixture.paths.platform.database);
    try {
      expect(
        await completeStartupRelocation(context, targetDatabase, {
          checkpoint: (checkpoint) => {
            if (checkpoint === 'source-deleted') throw new Error('stop after source removal');
          }
        })
      ).toEqual({ cleanupPhase: 'source-removed' });
    } finally {
      targetDatabase.close();
    }
    expect(await pathExists(fixture.paths.project.root)).toBe(false);
    dropCanonicalIndex(fixture.paths.platform.database);
    const protectedPaths = [
      fixture.paths.platform.database,
      `${fixture.paths.platform.database}-wal`,
      `${fixture.paths.platform.database}-shm`,
      `${fixture.paths.platform.database}-journal`,
      fixture.paths.project.root,
      fixture.paths.platform.root,
      join(fixture.paths.project.root, ROOT_MARKER_FILE),
      join(fixture.paths.platform.root, ROOT_MARKER_FILE),
      join(fixture.paths.platform.root, ROOT_RELOCATION_MANIFEST_FILE),
      join(fixture.paths.platform.root, '.poyo-stage-owner.json')
    ];
    const before = await snapshotPaths(protectedPaths);

    await expect(
      selectRootForStartup(fixture.paths.project, fixture.paths.platform)
    ).rejects.toMatchObject({ code: 'database_incompatible' });

    expect(await snapshotPaths(protectedPaths)).toEqual(before);
    expect(await readRootMarker(fixture.paths.platform.root)).toMatchObject({
      status: 'valid',
      marker: { state: 'active', peerRootKind: 'project' }
    });
    expect(
      await Bun.file(join(fixture.paths.platform.root, ROOT_RELOCATION_MANIFEST_FILE)).exists()
    ).toBe(true);
  });

  test('retries identity-bound source residue after the marker is unlinked', async () => {
    const fixture = await createFixture();
    await relocate(fixture);
    fixture.database.close();
    const context = await provisionalContext(fixture);
    await beginProvisionalActivation(context, {});
    const targetDatabase = await openDatabase(fixture.paths.platform.database);
    try {
      let failed = false;
      expect(
        await completeStartupRelocation(context, targetDatabase, {
          checkpoint: async (checkpoint) => {
            if (
              !failed &&
              checkpoint === 'source-entry-unlinked' &&
              !(await Bun.file(join(fixture.paths.project.root, '.poyo-root.json')).exists())
            ) {
              failed = true;
              throw new Error('injected per-entry unlink failure');
            }
          }
        })
      ).toEqual({ cleanupPhase: 'source-deletion-in-progress' });
      expect(failed).toBe(true);
      expect(await pathExists(fixture.paths.project.root)).toBe(true);
      const durableManifest = (await Bun.file(
        join(fixture.paths.platform.root, ROOT_RELOCATION_MANIFEST_FILE)
      ).json()) as {
        sourceDatabaseEntries: Array<{
          path: string;
          sourceDevice: number;
          sourceInode: number;
          size: number;
          sha256: string;
        }>;
      };
      const databaseEntry = durableManifest.sourceDatabaseEntries.find(
        (entry) => entry.path === 'poyo-studio.sqlite'
      );
      if (!databaseEntry) throw new Error('Expected a refreshed source database identity.');
      const databaseDetails = await lstat(fixture.paths.project.database);
      const databaseBytes = new Uint8Array(
        await Bun.file(fixture.paths.project.database).arrayBuffer()
      );
      expect(databaseEntry).toMatchObject({
        sourceDevice: databaseDetails.dev,
        sourceInode: databaseDetails.ino,
        size: databaseBytes.byteLength,
        sha256: new Bun.CryptoHasher('sha256').update(databaseBytes).digest('hex')
      });

      const selection = await selectRootForStartup(fixture.paths.project, fixture.paths.platform);
      const recovered = await resolveStartupRelocation({
        selection,
        candidates: fixture.paths,
        environment: {}
      });
      expect(recovered.kind).toBe('cleanup');
      expect(await completeStartupRelocation(recovered, targetDatabase)).toEqual({
        cleanupPhase: 'complete'
      });
    } finally {
      targetDatabase.close();
    }
    expect(await pathExists(fixture.paths.project.root)).toBe(false);
  });

  test('never deletes an unknown source file created after residue verification', async () => {
    const fixture = await createFixture();
    await relocate(fixture);
    fixture.database.close();
    const context = await provisionalContext(fixture);
    await beginProvisionalActivation(context, {});
    const targetDatabase = await openDatabase(fixture.paths.platform.database);
    const injected = join(
      fixture.paths.project.secrets,
      'independently-created-after-verification.txt'
    );
    try {
      let injectedOnce = false;
      expect(
        await completeStartupRelocation(context, targetDatabase, {
          checkpoint: async (checkpoint) => {
            if (checkpoint !== 'source-entry-unlinked' || injectedOnce) return;
            injectedOnce = true;
            await mkdir(fixture.paths.project.secrets, { recursive: true, mode: 0o700 });
            await Bun.write(injected, 'independent source data', { mode: 0o600 });
          }
        })
      ).toEqual({ cleanupPhase: 'source-deletion-in-progress' });
      expect(injectedOnce).toBe(true);
      expect(await Bun.file(injected).text()).toBe('independent source data');
      expect(await pathExists(fixture.paths.project.root)).toBe(true);
    } finally {
      targetDatabase.close();
    }
  });

  test('retains a source entry replaced with a different filesystem identity during cleanup', async () => {
    const fixture = await createFixture();
    await relocate(fixture);
    fixture.database.close();
    const context = await provisionalContext(fixture);
    await beginProvisionalActivation(context, {});
    const targetDatabase = await openDatabase(fixture.paths.platform.database);
    try {
      let swapped = false;
      expect(
        await completeStartupRelocation(context, targetDatabase, {
          checkpoint: async (checkpoint) => {
            if (checkpoint !== 'source-entry-unlinked' || swapped) return;
            swapped = true;
            await unlink(fixture.unknownFile);
            await mkdir(fixture.unknownFile, { mode: 0o700 });
          }
        })
      ).toEqual({ cleanupPhase: 'source-deletion-in-progress' });
      expect(swapped).toBe(true);
      expect((await lstat(fixture.unknownFile)).isDirectory()).toBe(true);
      expect(await pathExists(fixture.paths.project.root)).toBe(true);
    } finally {
      targetDatabase.close();
    }
  });

  test('restores and retains a file swapped at the exact pre-destructive quarantine boundary', async () => {
    const fixture = await createFixture();
    await relocate(fixture);
    fixture.database.close();
    const context = await provisionalContext(fixture);
    await beginProvisionalActivation(context, {});
    const targetDatabase = await openDatabase(fixture.paths.platform.database);
    const retainedOriginal = join(fixture.paths.project.root, '..', 'retained-original-file');
    const replacement = 'independently-replaced-at-boundary';
    let swapped = false;
    try {
      expect(
        await completeStartupRelocation(context, targetDatabase, {
          checkpoint: swapAtPreDestructiveBoundary(
            fixture.paths.platform.root,
            relative(fixture.paths.project.root, fixture.unknownFile),
            async () => {
              swapped = true;
              await rename(fixture.unknownFile, retainedOriginal);
              await Bun.write(fixture.unknownFile, replacement, { mode: 0o600 });
            }
          )
        })
      ).toEqual({ cleanupPhase: 'source-deletion-in-progress' });
    } finally {
      targetDatabase.close();
    }
    expect(swapped).toBe(true);
    expect(await Bun.file(fixture.unknownFile).text()).toBe(replacement);
    expect(await Bun.file(retainedOriginal).text()).toBe('future-compatible-root-data');
  });

  test('restores and retains a valid-looking marker swapped at the exact pre-destructive boundary', async () => {
    const fixture = await createFixture();
    await relocate(fixture);
    fixture.database.close();
    const context = await provisionalContext(fixture);
    await beginProvisionalActivation(context, {});
    const targetDatabase = await openDatabase(fixture.paths.platform.database);
    const marker = join(fixture.paths.project.root, ROOT_MARKER_FILE);
    const retainedOriginal = join(fixture.paths.project.root, '..', 'retained-original-marker');
    let swapped = false;
    try {
      expect(
        await completeStartupRelocation(context, targetDatabase, {
          checkpoint: swapAtPreDestructiveBoundary(
            fixture.paths.platform.root,
            ROOT_MARKER_FILE,
            async () => {
              swapped = true;
              const text = await Bun.file(marker).text();
              await rename(marker, retainedOriginal);
              await Bun.write(marker, text, { mode: 0o600 });
            }
          )
        })
      ).toEqual({ cleanupPhase: 'source-deletion-in-progress' });
    } finally {
      targetDatabase.close();
    }
    expect(swapped).toBe(true);
    expect(await Bun.file(marker).text()).toBe(await Bun.file(retainedOriginal).text());
    expect(await pathExists(fixture.paths.project.root)).toBe(true);
  });

  test('restores and retains a type swap at the exact pre-destructive quarantine boundary', async () => {
    const fixture = await createFixture();
    await relocate(fixture);
    fixture.database.close();
    const context = await provisionalContext(fixture);
    await beginProvisionalActivation(context, {});
    const targetDatabase = await openDatabase(fixture.paths.platform.database);
    const retainedOriginal = join(fixture.paths.project.root, '..', 'retained-before-type-swap');
    let swapped = false;
    try {
      expect(
        await completeStartupRelocation(context, targetDatabase, {
          checkpoint: swapAtPreDestructiveBoundary(
            fixture.paths.platform.root,
            relative(fixture.paths.project.root, fixture.unknownFile),
            async () => {
              swapped = true;
              await rename(fixture.unknownFile, retainedOriginal);
              await mkdir(fixture.unknownFile, { mode: 0o700 });
            }
          )
        })
      ).toEqual({ cleanupPhase: 'source-deletion-in-progress' });
    } finally {
      targetDatabase.close();
    }
    expect(swapped).toBe(true);
    expect((await lstat(fixture.unknownFile)).isDirectory()).toBe(true);
    expect(await Bun.file(retainedOriginal).text()).toBe('future-compatible-root-data');
  });

  test('resumes cleanup after a crash checkpoint leaves a verified entry in quarantine', async () => {
    const fixture = await createFixture();
    await relocate(fixture);
    fixture.database.close();
    const context = await provisionalContext(fixture);
    await beginProvisionalActivation(context, {});
    const targetDatabase = await openDatabase(fixture.paths.platform.database);
    let interrupted = false;
    try {
      expect(
        await completeStartupRelocation(context, targetDatabase, {
          checkpoint: (checkpoint) => {
            if (checkpoint === 'source-entry-quarantined' && !interrupted) {
              interrupted = true;
              throw new Error('injected crash after quarantine rename');
            }
          }
        })
      ).toEqual({ cleanupPhase: 'source-deletion-in-progress' });
      expect(interrupted).toBe(true);

      const selection = await selectRootForStartup(fixture.paths.project, fixture.paths.platform);
      const recovered = await resolveStartupRelocation({
        selection,
        candidates: fixture.paths,
        environment: {}
      });
      expect(await completeStartupRelocation(recovered, targetDatabase)).toEqual({
        cleanupPhase: 'complete'
      });
    } finally {
      targetDatabase.close();
    }
    expect(await pathExists(fixture.paths.project.root)).toBe(false);
  });

  test.each([
    'owned/../../outside-canary.txt',
    'owned/./outside-canary.txt',
    'owned//outside-canary.txt',
    'owned\\..\\outside-canary.txt'
  ])(
    'rejects every non-canonical manifest path component without touching outside data: %s',
    async (tamperedPath) => {
      const fixture = await createFixture();
      const outsideCanary = join(fixture.paths.project.root, '..', 'outside-canary.txt');
      await Bun.write(outsideCanary, 'outside data must survive', { mode: 0o600 });
      await relocate(fixture);
      fixture.database.close();
      const context = await provisionalContext(fixture);
      await beginProvisionalActivation(context, {});
      const targetDatabase = await openDatabase(fixture.paths.platform.database);
      try {
        expect(
          await completeStartupRelocation(context, targetDatabase, {
            checkpoint: (checkpoint) => {
              if (checkpoint === 'source-entry-before-quarantine') {
                throw new Error('stop before the first destructive boundary');
              }
            }
          })
        ).toEqual({ cleanupPhase: 'source-deletion-in-progress' });
      } finally {
        targetDatabase.close();
      }

      const manifestPath = join(fixture.paths.platform.root, ROOT_RELOCATION_MANIFEST_FILE);
      const manifest = (await Bun.file(manifestPath).json()) as {
        entries: Array<{ path: string }>;
      };
      const entry = manifest.entries.find(
        (candidate) => candidate.path === 'future-owned-entry.bin'
      );
      if (!entry) throw new Error('Expected relocation manifest file entry.');
      entry.path = tamperedPath;
      await Bun.write(manifestPath, `${JSON.stringify(manifest)}\n`);

      const selection = await selectRootForStartup(fixture.paths.project, fixture.paths.platform);
      await expect(
        resolveStartupRelocation({ selection, candidates: fixture.paths, environment: {} })
      ).rejects.toMatchObject({ code: 'manifest_invalid' });
      expect(await Bun.file(outsideCanary).text()).toBe('outside data must survive');
      expect(await pathExists(fixture.paths.project.root)).toBe(true);
    }
  );

  test.each(['source-deleted', 'target-finalized'] as const)(
    'finalizes target control state after cleanup checkpoint failure: %s',
    async (failedAt) => {
      const fixture = await createFixture();
      await relocate(fixture);
      fixture.database.close();
      const context = await provisionalContext(fixture);
      await beginProvisionalActivation(context, {});
      const targetDatabase = await openDatabase(fixture.paths.platform.database);
      try {
        expect(
          await completeStartupRelocation(context, targetDatabase, {
            checkpoint: (checkpoint) => {
              if (checkpoint === failedAt) throw new Error(`crash:${checkpoint}`);
            }
          })
        ).toEqual({
          cleanupPhase:
            failedAt === 'source-deleted' ? 'source-removed' : 'target-finalization-pending'
        });
      } finally {
        targetDatabase.close();
      }
      expect(await pathExists(fixture.paths.project.root)).toBe(false);
      expect(
        await pathExists(join(fixture.paths.platform.root, ROOT_RELOCATION_MANIFEST_FILE))
      ).toBe(true);

      const selection = await selectRootForStartup(fixture.paths.project, fixture.paths.platform);
      const recovered = await resolveStartupRelocation({
        selection,
        candidates: fixture.paths,
        environment: {}
      });
      expect(recovered.kind).toBe('cleanup');
      const recoveryDatabase = await openDatabase(fixture.paths.platform.database);
      try {
        expect(await completeStartupRelocation(recovered, recoveryDatabase)).toEqual({
          cleanupPhase: 'complete'
        });
      } finally {
        recoveryDatabase.close();
      }
      expect(await readRootMarker(fixture.paths.platform.root)).toMatchObject({
        status: 'valid',
        marker: { state: 'active', peerRootKind: null }
      });
      expect(
        await pathExists(join(fixture.paths.platform.root, ROOT_RELOCATION_MANIFEST_FILE))
      ).toBe(false);
    }
  );

  test('keeps a disjoint environment database in place and rebases it transactionally', async () => {
    const fixture = await createPublishedExternalDatabaseFixture();

    const afterPublication = await lstat(fixture.externalDatabase);
    expect({ dev: afterPublication.dev, ino: afterPublication.ino }).toEqual({
      dev: fixture.before.dev,
      ino: fixture.before.ino
    });
    expect(await pathExists(join(fixture.paths.platform.root, 'poyo-studio.sqlite'))).toBe(false);

    try {
      applyExternalDatabaseRebase(fixture.context, fixture.targetDatabase);
      applyExternalDatabaseRebase(fixture.context, fixture.targetDatabase);
      expect(await completeStartupRelocation(fixture.context, fixture.targetDatabase)).toEqual({
        cleanupPhase: 'complete'
      });
      const storage = fixture.targetDatabase
        .query<{ value_json: string }, []>(
          "SELECT value_json FROM app_settings WHERE key='storage'"
        )
        .get();
      expect(storage?.value_json).toContain(fixture.paths.platform.root);
      expect(storage?.value_json).not.toContain(fixture.paths.project.root);
    } finally {
      fixture.targetDatabase.close();
    }
    const afterActivation = await lstat(fixture.externalDatabase);
    expect({ dev: afterActivation.dev, ino: afterActivation.ino }).toEqual({
      dev: fixture.before.dev,
      ino: fixture.before.ino
    });
    expect(await pathExists(fixture.paths.project.root)).toBe(false);
  });

  test('reverses an external database rebase when provisional activation fails', async () => {
    const fixture = await createPublishedExternalDatabaseFixture();
    try {
      applyExternalDatabaseRebase(fixture.context, fixture.targetDatabase);
      await rollbackProvisionalActivation(fixture.context, fixture.targetDatabase);
      const storage = fixture.targetDatabase
        .query<{ value_json: string }, []>(
          "SELECT value_json FROM app_settings WHERE key='storage'"
        )
        .get();
      expect(storage?.value_json).toContain(fixture.paths.project.root);
      expect(storage?.value_json).not.toContain(fixture.paths.platform.root);
    } finally {
      fixture.targetDatabase.close();
    }
    const afterRollback = await lstat(fixture.externalDatabase);
    expect({ dev: afterRollback.dev, ino: afterRollback.ino }).toEqual({
      dev: fixture.before.dev,
      ino: fixture.before.ino
    });
    expect(await pathExists(fixture.paths.project.root)).toBe(true);
    expect(await readRootMarker(fixture.paths.project.root)).toMatchObject({
      status: 'valid',
      marker: { state: 'active' }
    });
    expect(await readRootMarker(fixture.paths.platform.root)).toMatchObject({
      status: 'valid',
      marker: { state: 'failed' }
    });
  });
});
