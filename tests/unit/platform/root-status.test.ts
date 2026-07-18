import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppPaths } from '../../../src/lib/server/platform/app-paths';
import { openDatabase } from '../../../src/lib/server/platform/database';
import {
  pendingStorageRootStatusDto,
  storageRootStatusDto
} from '../../../src/lib/server/platform/root-status';
import {
  createInitialProjectMarker,
  promoteInitialProjectMarker,
  writeRootMarker
} from '../../../src/lib/server/platform/root-selector';
import { createTemporaryDirectory } from '../../helpers/temporary-directory';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function paths(root: string, rootKind: AppPaths['rootKind']): AppPaths {
  return {
    root,
    database: join(root, 'poyo-studio.sqlite'),
    media: join(root, 'media'),
    uploads: join(root, 'uploads'),
    thumbnails: join(root, 'thumbnails'),
    logs: join(root, 'logs'),
    secrets: join(root, 'secrets'),
    temporary: join(root, 'tmp'),
    source:
      rootKind === 'environment'
        ? 'environment'
        : rootKind === 'platform'
          ? 'platform-selected'
          : 'project-default',
    rootKind
  };
}

describe('safe application-root status DTO', () => {
  test('shows project data as the active default without exposing its absolute path', async () => {
    const temporary = await createTemporaryDirectory('root-status-');
    cleanups.push(temporary.cleanup);
    await writeRootMarker(
      temporary.path,
      promoteInitialProjectMarker(createInitialProjectMarker())
    );
    const status = await storageRootStatusDto({
      paths: paths(temporary.path, 'project'),
      runtime: { cleanupPhase: 'none' },
      gate: {
        status: () => ({
          admission: 'open',
          activeWriters: 0,
          detachedTasks: 0,
          writerGeneration: 0
        })
      },
      platform: 'darwin'
    });
    expect(status).toMatchObject({
      current: { kind: 'project', label: 'Project data folder', location: './data' },
      selected: { kind: 'project' },
      effective: { kind: 'project' },
      state: 'active',
      sourceRetention: 'none',
      cleanupPhase: 'none',
      exclusions: [],
      mutationAvailable: true,
      restartRequired: false
    });
    expect(JSON.stringify(status)).not.toContain(temporary.path);
  });

  test('reports every frozen gate as restart-required without inventing a pending root move', async () => {
    const temporary = await createTemporaryDirectory('root-status-frozen-');
    cleanups.push(temporary.cleanup);
    await writeRootMarker(
      temporary.path,
      promoteInitialProjectMarker(createInitialProjectMarker())
    );
    const status = await storageRootStatusDto({
      paths: paths(temporary.path, 'project'),
      runtime: { cleanupPhase: 'none' },
      environment: {
        PLS_DATABASE_PATH: join(temporary.path, '..', 'external.sqlite'),
        PLS_MEDIA_DIR: join(temporary.path, '..', 'external-media'),
        PLS_LOG_DIR: join(temporary.path, '..', 'external-logs')
      },
      gate: {
        status: () => ({
          admission: 'frozen',
          activeWriters: 0,
          detachedTasks: 0,
          writerGeneration: 3
        })
      },
      platform: 'darwin'
    });

    expect(status).toMatchObject({
      current: { kind: 'project' },
      selected: { kind: 'project' },
      state: 'restart-required',
      mutationAvailable: false,
      restartRequired: true,
      exclusions: [
        { resource: 'database', environmentManaged: true, copied: false },
        { resource: 'media', environmentManaged: true, copied: false },
        { resource: 'logs', environmentManaged: true, copied: false }
      ]
    });
    expect(JSON.stringify(status)).not.toContain(temporary.path);
  });

  test('reports path-free current and historical external output exclusions with canonical counts', async () => {
    const temporary = await createTemporaryDirectory('root-status-external-output-');
    cleanups.push(temporary.cleanup);
    const root = join(temporary.path, 'current-root');
    const alternate = join(temporary.path, 'alternate-root');
    const currentOutput = join(temporary.path, 'external-current');
    const historicalOne = join(temporary.path, 'external-history-one');
    const historicalTwo = join(temporary.path, 'external-history-two');
    await Promise.all(
      [root, alternate, currentOutput, historicalOne, historicalTwo].map((path) =>
        mkdir(path, { recursive: true })
      )
    );
    await writeRootMarker(root, promoteInitialProjectMarker(createInitialProjectMarker()));
    const database = await openDatabase(join(root, 'poyo-studio.sqlite'));
    database
      .query('INSERT INTO app_settings(key,value_version,value_json,updated_at) VALUES (?,?,?,?)')
      .run(
        'storage',
        1,
        JSON.stringify({
          outputDirectory: currentOutput,
          previousRoots: [currentOutput, historicalOne, historicalTwo, join(root, 'media')]
        }),
        '2026-07-18T00:00:00.000Z'
      );
    try {
      const status = await storageRootStatusDto({
        paths: paths(root, 'project'),
        runtime: { cleanupPhase: 'none' },
        database,
        candidateRoots: [root, alternate],
        gate: {
          status: () => ({
            admission: 'open',
            activeWriters: 0,
            detachedTasks: 0,
            writerGeneration: 0
          })
        }
      });
      expect(status.exclusions).toEqual([
        {
          resource: 'current-output-directory',
          environmentManaged: false,
          count: 1,
          copied: false
        },
        {
          resource: 'historical-output-directories',
          environmentManaged: false,
          count: 2,
          copied: false
        }
      ]);
      const serialized = JSON.stringify(status);
      expect(serialized).not.toContain(temporary.path);
      expect(serialized).not.toContain(currentOutput);
    } finally {
      database.close();
    }
  });

  test('reports a published move as restart-required with source retention', async () => {
    const status = await pendingStorageRootStatusDto({
      currentRootKind: 'project',
      targetRootKind: 'platform',
      platform: 'darwin'
    });
    expect(status).toMatchObject({
      current: { kind: 'project', location: './data' },
      selected: {
        kind: 'platform',
        label: 'macOS Application Support',
        location: '~/Library/Application Support/Poyo Local Studio'
      },
      effective: { kind: 'project' },
      state: 'restart-required',
      sourceRetention: 'retained-until-restart',
      mutationAvailable: false,
      restartRequired: true
    });
  });

  test.each([
    ['source-retained', 'retained-cleanup-pending'],
    ['source-deletion-in-progress', 'residue-cleanup-pending'],
    ['source-removed', 'removed'],
    ['target-finalization-pending', 'removed']
  ] as const)(
    'reports cleanup phase %s without overstating source retention',
    async (phase, retention) => {
      const temporary = await createTemporaryDirectory(`root-status-${phase}-`);
      cleanups.push(temporary.cleanup);
      await writeRootMarker(
        temporary.path,
        promoteInitialProjectMarker(createInitialProjectMarker())
      );
      const status = await storageRootStatusDto({
        paths: paths(temporary.path, 'project'),
        runtime: { cleanupPhase: phase },
        gate: {
          status: () => ({
            admission: 'open',
            activeWriters: 0,
            detachedTasks: 0,
            writerGeneration: 0
          })
        }
      });
      expect(status).toMatchObject({
        state: 'cleanup-pending',
        cleanupPhase: phase,
        sourceRetention: retention,
        mutationAvailable: false
      });
    }
  );

  test('environment authority disables in-app root mutation', async () => {
    const status = await storageRootStatusDto({
      paths: paths('/not-read-by-environment-status', 'environment'),
      runtime: { cleanupPhase: 'none' },
      gate: {
        status: () => ({
          admission: 'open',
          activeWriters: 0,
          detachedTasks: 0,
          writerGeneration: 0
        })
      },
      platform: 'darwin'
    });
    expect(status).toMatchObject({
      current: { kind: 'environment', location: 'PLS_APP_DATA_DIR' },
      selected: { kind: 'environment' },
      effective: { kind: 'environment' },
      state: 'environment-managed',
      environmentManaged: true,
      mutationAvailable: false
    });
  });
});
