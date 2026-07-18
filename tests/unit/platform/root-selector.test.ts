import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { migrations } from '../../../migrations';
import { resolveAppPathCandidates } from '../../../src/lib/server/platform/app-paths';
import { migrateDatabase, migrationChecksum } from '../../../src/lib/server/platform/database';
import {
  createInitialProjectMarker,
  preflightEnvironmentRoot,
  promoteInitialProjectMarker,
  ROOT_MARKER_FILE,
  ROOT_SCHEMA_SIGNATURE_ID,
  type RootMarkerProbe,
  type RootMarkerState,
  type RootMarkerV1,
  RootSelectionError,
  readRootMarker,
  reduceRootMarkers,
  selectRootForStartup,
  writeRootMarker
} from '../../../src/lib/server/platform/root-selector';
import { createTemporaryDirectory } from '../../helpers/temporary-directory';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function probe(marker: RootMarkerV1): RootMarkerProbe {
  return { status: 'valid', marker };
}

function pairedMarkers(
  sourceState: RootMarkerState,
  targetState: RootMarkerState
): [RootMarkerV1, RootMarkerV1] {
  const sourceIdentity = 'source_identity_123';
  const targetIdentity = 'target_identity_123';
  const transitionId = 'transition_123';
  return [
    {
      version: 1,
      rootKind: 'project',
      rootIdentityNonce: sourceIdentity,
      generation: 1,
      transitionId,
      state: sourceState,
      peerRootKind: 'platform',
      peerRootIdentityNonce: targetIdentity,
      rebasePhase: 'none',
      safeErrorCode: null,
      schemaSignatureId: ROOT_SCHEMA_SIGNATURE_ID
    },
    {
      version: 1,
      rootKind: 'platform',
      rootIdentityNonce: targetIdentity,
      generation: 2,
      transitionId,
      state: targetState,
      peerRootKind: 'project',
      peerRootIdentityNonce: sourceIdentity,
      rebasePhase: 'complete',
      safeErrorCode: null,
      schemaSignatureId: ROOT_SCHEMA_SIGNATURE_ID
    }
  ];
}

function createSchemaHistory(path: string, version: number, registered = false): void {
  const database = new Database(path, { create: true, strict: true });
  if (registered && version === 1) {
    migrateDatabase(database);
    database.close();
    return;
  }
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const expected = migrations.find((migration) => migration.version === version);
  database
    .query('INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
    .run(
      version,
      registered && expected ? expected.name : 'fixture',
      registered && expected ? migrationChecksum(expected) : 'fixture-checksum',
      '2026-07-17T00:00:00.000Z'
    );
  database.close();
}

describe('root marker reducer', () => {
  test('selects a fresh project root when neither candidate has a marker', () => {
    expect(reduceRootMarkers({ status: 'absent' }, { status: 'absent' })).toEqual({
      selected: 'project',
      mode: 'initialize',
      action: 'initialize-project'
    });
  });

  test.each([
    ['active-intent', 'prepared', 'platform', 'provisional', 'activate-target'],
    ['active-intent', 'activating', 'platform', 'provisional', 'activate-target'],
    ['active', 'prepared', 'project', 'frozen', 'repair-source-intent'],
    ['active-intent', 'active', 'platform', 'normal', 'cleanup-source'],
    ['active', 'active', 'platform', 'normal', 'cleanup-source'],
    ['cleanup-pending', 'active', 'platform', 'normal', 'cleanup-source'],
    ['cleanup-pending', 'activating', 'project', 'frozen', 'restore-source'],
    ['active', 'failed', 'project', 'normal', 'quarantine-target'],
    ['active-intent', 'failed', 'project', 'frozen', 'restore-source']
  ] as const)(
    'reduces %s/%s to %s %s with %s',
    (sourceState, targetState, selected, mode, action) => {
      const [source, target] = pairedMarkers(sourceState, targetState);
      expect(reduceRootMarkers(probe(source), probe(target))).toEqual({ selected, mode, action });
    }
  );

  test('fails closed on unrelated or corrupt markers', () => {
    const [source, target] = pairedMarkers('active', 'active');
    expect(() =>
      reduceRootMarkers(probe(source), probe({ ...target, transitionId: 'unrelated_123' }))
    ).toThrow(RootSelectionError);
    expect(() =>
      reduceRootMarkers({ status: 'corrupt', code: 'marker_invalid' }, probe(target))
    ).toThrow('corrupt');
  });
});

describe('startup root selection', () => {
  test('ignores markerless legacy platform contents and does not create the project root', async () => {
    const temporary = await createTemporaryDirectory('poyo-root-select-');
    cleanups.push(temporary.cleanup);
    const candidates = resolveAppPathCandidates({
      environment: {},
      platform: 'darwin',
      homeDirectory: join(temporary.path, 'home'),
      projectRoot: join(temporary.path, 'repo')
    });
    await mkdir(candidates.platform.root, { recursive: true });
    const legacyPath = join(candidates.platform.root, 'legacy.txt');
    await Bun.write(legacyPath, 'must-not-be-selected');

    const selection = await selectRootForStartup(candidates.project, candidates.platform);
    expect(selection.decision).toMatchObject({ selected: 'project', mode: 'initialize' });
    expect(await Bun.file(candidates.project.root).exists()).toBe(false);
    expect(await Bun.file(legacyPath).text()).toBe('must-not-be-selected');
  });

  test('selects platform storage only when a valid active marker explicitly authorizes it', async () => {
    const temporary = await createTemporaryDirectory('poyo-platform-select-');
    cleanups.push(temporary.cleanup);
    const candidates = resolveAppPathCandidates({
      environment: {},
      platform: 'darwin',
      homeDirectory: join(temporary.path, 'home'),
      projectRoot: join(temporary.path, 'repo')
    });
    await mkdir(candidates.platform.root, { recursive: true });
    createSchemaHistory(candidates.platform.database, 1, true);
    const [, platform] = pairedMarkers('cleanup-pending', 'active');
    await writeRootMarker(candidates.platform.root, platform);

    const selection = await selectRootForStartup(candidates.project, candidates.platform);
    expect(selection.paths.root).toBe(candidates.platform.root);
    expect(selection.decision).toEqual({
      selected: 'platform',
      mode: 'normal',
      action: 'cleanup-source'
    });
  });

  test('rejects unknown markerless project contents without changing them', async () => {
    const temporary = await createTemporaryDirectory('poyo-unknown-root-');
    cleanups.push(temporary.cleanup);
    const candidates = resolveAppPathCandidates({
      environment: {},
      platform: 'linux',
      homeDirectory: join(temporary.path, 'home'),
      projectRoot: join(temporary.path, 'repo')
    });
    await mkdir(candidates.project.root, { recursive: true });
    const unknown = join(candidates.project.root, 'unknown.bin');
    await Bun.write(unknown, 'unchanged');

    await expect(selectRootForStartup(candidates.project, candidates.platform)).rejects.toThrow(
      'unknown data'
    );
    expect(await Bun.file(unknown).text()).toBe('unchanged');
    expect(await Bun.file(join(candidates.project.root, ROOT_MARKER_FILE)).exists()).toBe(false);
  });

  test('resumes a generation-1 activating marker without misclassifying it as unknown data', async () => {
    const temporary = await createTemporaryDirectory('poyo-initial-root-resume-');
    cleanups.push(temporary.cleanup);
    const candidates = resolveAppPathCandidates({
      environment: {},
      platform: 'linux',
      homeDirectory: join(temporary.path, 'home'),
      projectRoot: join(temporary.path, 'repo')
    });
    const marker = createInitialProjectMarker();
    await writeRootMarker(candidates.project.root, marker);
    await mkdir(candidates.project.uploads);

    const selection = await selectRootForStartup(candidates.project, candidates.platform);

    expect(selection.paths.root).toBe(candidates.project.root);
    expect(selection.decision).toEqual({
      selected: 'project',
      mode: 'initialize',
      action: 'initialize-project'
    });
    expect(await readRootMarker(candidates.project.root)).toEqual(probe(marker));
  });

  test('rejects an active former version-4 project root without changing its authority files', async () => {
    const temporary = await createTemporaryDirectory('poyo-incompatible-root-');
    cleanups.push(temporary.cleanup);
    const candidates = resolveAppPathCandidates({
      environment: {},
      platform: 'linux',
      homeDirectory: join(temporary.path, 'home'),
      projectRoot: join(temporary.path, 'repo')
    });
    const marker = promoteInitialProjectMarker(createInitialProjectMarker());
    await writeRootMarker(candidates.project.root, marker);
    createSchemaHistory(candidates.project.database, 4);
    const markerBefore = await Bun.file(join(candidates.project.root, ROOT_MARKER_FILE)).text();
    const databaseBefore = new Uint8Array(
      await Bun.file(candidates.project.database).arrayBuffer()
    );

    await expect(
      selectRootForStartup(candidates.project, candidates.platform)
    ).rejects.toMatchObject({
      code: 'database_incompatible'
    });

    expect(await Bun.file(join(candidates.project.root, ROOT_MARKER_FILE)).text()).toBe(
      markerBefore
    );
    expect(new Uint8Array(await Bun.file(candidates.project.database).arrayBuffer())).toEqual(
      databaseBefore
    );
    expect(await Bun.file(`${candidates.project.database}-wal`).exists()).toBe(false);
    expect(await Bun.file(`${candidates.project.database}-shm`).exists()).toBe(false);
  });

  test('environment-managed roots bypass marker parsing while retaining database preflight', async () => {
    const temporary = await createTemporaryDirectory('poyo-environment-root-');
    cleanups.push(temporary.cleanup);
    const candidates = resolveAppPathCandidates({
      environment: {},
      platform: 'linux',
      homeDirectory: join(temporary.path, 'home'),
      projectRoot: join(temporary.path, 'repo')
    });
    await mkdir(candidates.project.root, { recursive: true });
    createSchemaHistory(candidates.project.database, 1, true);
    const markerPath = join(candidates.project.root, ROOT_MARKER_FILE);
    await Bun.write(markerPath, '{ invalid marker contents');
    const markerBefore = await Bun.file(markerPath).text();

    await expect(preflightEnvironmentRoot(candidates.project)).resolves.toBeUndefined();
    expect(await Bun.file(markerPath).text()).toBe(markerBefore);
  });
});

describe('atomic root marker publication', () => {
  test('writes a private parseable marker and atomically promotes initial authority', async () => {
    const temporary = await createTemporaryDirectory('poyo-marker-write-');
    cleanups.push(temporary.cleanup);
    const root = join(temporary.path, 'data');
    const initial = createInitialProjectMarker();
    await writeRootMarker(root, initial);
    expect(await readRootMarker(root)).toEqual(probe(initial));

    const active = promoteInitialProjectMarker(initial);
    await writeRootMarker(root, active);
    expect(await readRootMarker(root)).toEqual(probe(active));
    expect(await readdir(root)).toEqual([ROOT_MARKER_FILE]);
    if (process.platform !== 'win32') {
      expect((await lstat(join(root, ROOT_MARKER_FILE))).mode & 0o077).toBe(0);
    }
  });
});
