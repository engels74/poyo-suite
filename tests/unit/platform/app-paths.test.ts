import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveProjectRoot,
  ensureAppPaths,
  ensureDirectoryExists,
  resolveAppPathCandidates,
  resolveAppPaths,
  resolvePathWithin
} from '../../../src/lib/server/platform/app-paths';
import { createTemporaryDirectory } from '../../helpers/temporary-directory';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('application paths', () => {
  test('defaults to project data while preserving explicit deterministic platform candidates', () => {
    const projectRoot = '/workspace/poyo-local-studio';
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(
        resolveAppPaths({
          environment: {},
          platform,
          homeDirectory: '/home/studio',
          projectRoot
        }).root
      ).toBe(join(projectRoot, 'data'));
    }
    const candidates = resolveAppPathCandidates({
      environment: {},
      platform: 'darwin',
      homeDirectory: '/Users/studio',
      projectRoot
    });
    expect(candidates.project.root).toBe(join(projectRoot, 'data'));
    expect(candidates.project.database).toBe(join(projectRoot, 'data', 'poyo-studio.sqlite'));
    expect(candidates.platform.root).toBe(
      '/Users/studio/Library/Application Support/Poyo Local Studio'
    );
    expect(candidates.platform.source).toBe('platform-selected');

    const configured = resolveAppPaths({
      environment: { PLS_APP_DATA_DIR: '/srv/poyo', PLS_LOG_DIR: '/var/log/poyo' },
      platform: 'linux',
      homeDirectory: '/home/studio'
    });
    expect(configured.root).toBe('/srv/poyo');
    expect(configured.logs).toBe('/var/log/poyo');
    expect(configured.source).toBe('environment');
  });

  test.serial('derives repository and production-build roots independently of cwd', async () => {
    const moduleDirectory = dirname(fileURLToPath(import.meta.url));
    const repositoryRoot = resolve(moduleDirectory, '../../..');
    expect(deriveProjectRoot()).toBe(repositoryRoot);
    expect(deriveProjectRoot(join(repositoryRoot, 'build', 'server', 'chunks'))).toBe(
      repositoryRoot
    );

    const temporary = await createTemporaryDirectory('poyo-changed-cwd-');
    cleanups.push(temporary.cleanup);
    const originalCwd = process.cwd();
    try {
      process.chdir(temporary.path);
      expect(
        resolveAppPaths({
          environment: {},
          platform: 'linux',
          homeDirectory: '/home/studio'
        }).root
      ).toBe(join(repositoryRoot, 'data'));
    } finally {
      process.chdir(originalCwd);
    }
  });

  test('fails project-root derivation without falling back to platform storage', () => {
    expect(() => deriveProjectRoot('/isolated/build/chunks', () => false)).toThrow(
      'Unable to derive'
    );
  });

  test('treats a whitespace-only PLS_MEDIA_DIR as unset and trims a real override', () => {
    // Whitespace is not a real override: media falls back to the default under the root, matching
    // the trim()-based "environment managed" check used by the output-location endpoints.
    const blank = resolveAppPaths({
      environment: { PLS_APP_DATA_DIR: '/srv/poyo', PLS_MEDIA_DIR: '   ' },
      platform: 'linux',
      homeDirectory: '/home/studio'
    });
    expect(blank.media).toBe('/srv/poyo/media');
    expect(blank.defaultMedia).toBe('/srv/poyo/media');

    const custom = resolveAppPaths({
      environment: { PLS_APP_DATA_DIR: '/srv/poyo', PLS_MEDIA_DIR: '  /mnt/media  ' },
      platform: 'linux',
      homeDirectory: '/home/studio'
    });
    expect(custom.media).toBe('/mnt/media');
    // defaultMedia stays the platform default regardless of the override, so the previous default
    // root remains available to mediaReadRoots for older outputs.
    expect(custom.defaultMedia).toBe('/srv/poyo/media');
  });

  test('creates private local directories and keeps paths inside configured roots', async () => {
    const temporary = await createTemporaryDirectory('poyo-paths-');
    cleanups.push(temporary.cleanup);
    const paths = resolveAppPaths({
      environment: { PLS_APP_DATA_DIR: join(temporary.path, 'studio') },
      platform: process.platform,
      homeDirectory: temporary.path
    });

    await ensureAppPaths(paths);
    expect(resolvePathWithin(paths.media, 'generation/output.png')).toBe(
      join(paths.media, 'generation', 'output.png')
    );
    expect(() => resolvePathWithin(paths.media, '../escape.png')).toThrow('escapes');
    expect(() => resolvePathWithin(paths.media, '/tmp/escape.png')).toThrow('escapes');
    if (process.platform !== 'win32') {
      expect((await lstat(paths.root)).mode & 0o077).toBe(0);
    }
  });

  test('ensureDirectoryExists keeps an existing user folder’s permissions instead of forcing 0o700', async () => {
    if (process.platform === 'win32') return;
    const temporary = await createTemporaryDirectory('poyo-writable-');
    cleanups.push(temporary.cleanup);
    const target = join(temporary.path, 'user-media');
    await mkdir(target, { recursive: true });
    await chmod(target, 0o755);
    await ensureDirectoryExists(target);
    // A user-chosen output folder must retain its own permissions (unlike the app's private dirs).
    expect((await lstat(target)).mode & 0o777).toBe(0o755);
  });

  test('ensureAppPaths keeps an environment-managed PLS_MEDIA_DIR folder’s permissions', async () => {
    if (process.platform === 'win32') return;
    const temporary = await createTemporaryDirectory('poyo-env-media-');
    cleanups.push(temporary.cleanup);

    const paths = resolveAppPaths({
      environment: {
        PLS_APP_DATA_DIR: join(temporary.path, 'studio'),
        PLS_MEDIA_DIR: join(temporary.path, 'shared-media')
      },
      platform: process.platform,
      homeDirectory: temporary.path
    });
    // The environment-managed case: media differs from the platform default under the app root.
    expect(paths.media).not.toBe(paths.defaultMedia);

    // Simulate an existing shared folder the operator pointed PLS_MEDIA_DIR at.
    await mkdir(paths.media, { recursive: true });
    await chmod(paths.media, 0o755);

    await ensureAppPaths(paths);

    // The environment-managed media folder keeps its own permissions (no forced 0o700 that would
    // change a shared folder or EPERM-fail startup), while the app's private root stays locked down.
    expect((await lstat(paths.media)).mode & 0o777).toBe(0o755);
    expect((await lstat(paths.root)).mode & 0o077).toBe(0);
  });
});
