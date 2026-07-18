import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AppPaths,
  resolveAppPathCandidates
} from '../../../src/lib/server/platform/app-paths';
import {
  assertRelocationTopology,
  RelocationTopologyError
} from '../../../src/lib/server/platform/root-topology';
import { createTemporaryDirectory } from '../../helpers/temporary-directory';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function candidates() {
  const temporary = await createTemporaryDirectory('poyo-root-topology-');
  cleanups.push(temporary.cleanup);
  return {
    temporary,
    paths: resolveAppPathCandidates({
      environment: {
        HOME: join(temporary.path, 'home'),
        XDG_DATA_HOME: join(temporary.path, 'xdg')
      },
      platform: 'linux',
      projectRoot: join(temporary.path, 'repo')
    })
  };
}

function withRoot(paths: AppPaths, root: string, rootKind: 'project' | 'platform'): AppPaths {
  return {
    ...paths,
    root,
    database: join(root, 'poyo-studio.sqlite'),
    media: join(root, 'media'),
    defaultMedia: join(root, 'media'),
    mediaReadRoots: [join(root, 'media')],
    uploads: join(root, 'uploads'),
    thumbnails: join(root, 'thumbnails'),
    logs: join(root, 'logs'),
    secrets: join(root, 'secrets'),
    temporary: join(root, 'tmp'),
    rootKind,
    source: rootKind === 'project' ? 'project-default' : 'platform-selected'
  };
}

describe('root relocation topology', () => {
  test('accepts canonically disjoint roots and disjoint environment-managed resources', async () => {
    const fixture = await candidates();
    await mkdir(fixture.paths.project.root, { recursive: true });
    const database = join(fixture.temporary.path, 'external', 'database.sqlite');
    await mkdir(join(fixture.temporary.path, 'external'), { recursive: true });
    await Bun.write(database, 'external-identity');

    const result = await assertRelocationTopology({
      source: fixture.paths.project,
      target: fixture.paths.platform,
      environment: {
        PLS_DATABASE_PATH: database,
        PLS_MEDIA_DIR: join(fixture.temporary.path, 'external-media'),
        PLS_LOG_DIR: join(fixture.temporary.path, 'external-logs')
      },
      platform: 'linux'
    });

    expect(result.databaseMode).toBe('external');
    expect(result.externalResources.map((resource) => resource.kind)).toEqual([
      'database',
      'database-wal',
      'database-shm',
      'database-journal',
      'media',
      'logs'
    ]);
    expect(await Bun.file(fixture.paths.platform.root).exists()).toBe(false);
  });

  test.each(['equal', 'source-ancestor', 'target-ancestor'] as const)(
    'rejects %s root overlap before creating the target',
    async (shape) => {
      const fixture = await candidates();
      const base = join(fixture.temporary.path, 'overlap');
      const sourceRoot = shape === 'target-ancestor' ? join(base, 'source') : base;
      const targetRoot =
        shape === 'equal' ? base : shape === 'source-ancestor' ? join(base, 'target') : base;
      await mkdir(sourceRoot, { recursive: true });
      const source = withRoot(fixture.paths.project, sourceRoot, 'project');
      const target = withRoot(fixture.paths.platform, targetRoot, 'platform');

      await expect(
        assertRelocationTopology({ source, target, environment: {}, platform: 'linux' })
      ).rejects.toMatchObject({ code: 'root_overlap' });
    }
  );

  test('rejects symlink aliases and case-folded Windows aliases', async () => {
    const fixture = await candidates();
    const sourceRoot = join(fixture.temporary.path, 'CaseRoot');
    const aliasRoot = join(fixture.temporary.path, 'alias-root');
    await mkdir(sourceRoot, { recursive: true });
    await symlink(sourceRoot, aliasRoot, 'dir');
    const source = withRoot(fixture.paths.project, sourceRoot, 'project');

    await expect(
      assertRelocationTopology({
        source,
        target: withRoot(fixture.paths.platform, aliasRoot, 'platform'),
        environment: {},
        platform: 'linux'
      })
    ).rejects.toMatchObject({ code: 'root_overlap' });
    await expect(
      assertRelocationTopology({
        source,
        target: withRoot(fixture.paths.platform, sourceRoot.toLowerCase(), 'platform'),
        environment: {},
        platform: 'win32'
      })
    ).rejects.toMatchObject({ code: 'root_overlap' });
  });

  test('rejects non-empty targets and overlapping environment paths without mutation', async () => {
    const fixture = await candidates();
    await mkdir(fixture.paths.project.root, { recursive: true });
    await mkdir(fixture.paths.platform.root, { recursive: true });
    const unrelated = join(fixture.paths.platform.root, 'unrelated.txt');
    await Bun.write(unrelated, 'keep');

    await expect(
      assertRelocationTopology({
        source: fixture.paths.project,
        target: fixture.paths.platform,
        environment: {},
        platform: 'linux'
      })
    ).rejects.toMatchObject({ code: 'target_not_empty' });
    expect(await Bun.file(unrelated).text()).toBe('keep');

    await expect(
      assertRelocationTopology({
        source: fixture.paths.project,
        target: withRoot(
          fixture.paths.platform,
          join(fixture.temporary.path, 'fresh-target'),
          'platform'
        ),
        environment: { PLS_MEDIA_DIR: join(fixture.paths.project.root, 'media') },
        platform: 'linux'
      })
    ).rejects.toMatchObject({ code: 'environment_path_overlap' });
  });

  test('rejects relocation when the root is environment-managed', async () => {
    const fixture = await candidates();
    await expect(
      assertRelocationTopology({
        source: fixture.paths.project,
        target: fixture.paths.platform,
        environment: { PLS_APP_DATA_DIR: fixture.paths.project.root },
        platform: 'linux'
      })
    ).rejects.toBeInstanceOf(RelocationTopologyError);
  });
});
