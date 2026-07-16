import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ensureAppPaths,
  ensureDirectoryExists,
  resolveAppPaths,
  resolvePathWithin
} from '../../../src/lib/server/platform/app-paths';
import { createTemporaryDirectory } from '../../helpers/temporary-directory';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('application paths', () => {
  test('uses platform conventions and explicit environment overrides', () => {
    expect(
      resolveAppPaths({ environment: {}, platform: 'darwin', homeDirectory: '/Users/studio' }).root
    ).toBe('/Users/studio/Library/Application Support/Poyo Local Studio');
    expect(
      resolveAppPaths({ environment: {}, platform: 'linux', homeDirectory: '/home/studio' }).root
    ).toBe('/home/studio/.local/share/poyo-local-studio');
    expect(
      resolveAppPaths({
        environment: { LOCALAPPDATA: 'C:\\Users\\studio\\AppData\\Local' },
        platform: 'win32',
        homeDirectory: 'C:\\Users\\studio'
      }).root
    ).toContain('Poyo Local Studio');

    const configured = resolveAppPaths({
      environment: { PLS_APP_DATA_DIR: '/srv/poyo', PLS_LOG_DIR: '/var/log/poyo' },
      platform: 'linux',
      homeDirectory: '/home/studio'
    });
    expect(configured.root).toBe('/srv/poyo');
    expect(configured.logs).toBe('/var/log/poyo');
    expect(configured.source).toBe('environment');
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
});
