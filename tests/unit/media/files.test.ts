import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertPrivateMediaRequest,
  MediaRangeError,
  openContainingFolder,
  parseByteRange,
  privateMediaHeaders,
  safeLocalMediaPath
} from '../../../src/lib/server/media/files';
import { createTemporaryDirectory } from '../../helpers/temporary-directory';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe('private local media boundary', () => {
  test('serves valid single ranges and rejects ambiguous or invalid ranges', () => {
    expect(parseByteRange(null, 100)).toBeNull();
    expect(parseByteRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseByteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(() => parseByteRange('bytes=0-1,3-4', 100)).toThrow(MediaRangeError);
    expect(() => parseByteRange('bytes=100-', 100)).toThrow(MediaRangeError);
    const headers = privateMediaHeaders('video/mp4', 10);
    expect(headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('blocks cross-site requests and symlink escapes from the configured media root', async () => {
    expect(() =>
      assertPrivateMediaRequest(
        new Request('http://127.0.0.1/api/media/id', {
          headers: { 'sec-fetch-site': 'cross-site' }
        })
      )
    ).toThrow('Cross-site');

    const temporary = await createTemporaryDirectory('poyo-media-');
    cleanups.push(temporary.cleanup);
    const root = join(temporary.path, 'media');
    const outside = join(temporary.path, 'outside.png');
    await mkdir(root);
    await writeFile(outside, 'secret');
    await symlink(outside, join(root, 'escape.png'));
    await expect(safeLocalMediaPath(root, join(root, 'escape.png'))).rejects.toThrow('escapes');
  });

  test('accepts a verified absolute path through a canonical ancestor alias', async () => {
    const temporary = await createTemporaryDirectory('poyo-media-alias-');
    cleanups.push(temporary.cleanup);
    const canonicalParent = join(temporary.path, 'canonical');
    const aliasedParent = join(temporary.path, 'alias');
    const canonicalRoot = join(canonicalParent, 'media');
    const aliasedRoot = join(aliasedParent, 'media');
    const canonicalFile = join(canonicalRoot, 'job', 'output.png');
    await mkdir(join(canonicalRoot, 'job'), { recursive: true });
    await writeFile(canonicalFile, 'image');
    await symlink(canonicalParent, aliasedParent, 'dir');

    expect(await safeLocalMediaPath(aliasedRoot, await realpath(canonicalFile))).toBe(
      await realpath(canonicalFile)
    );
  });

  test('opens only the verified containing folder with the platform command', async () => {
    const temporary = await createTemporaryDirectory('poyo-folder-');
    cleanups.push(temporary.cleanup);
    const root = join(temporary.path, 'media');
    const file = join(root, 'job', 'output.png');
    await mkdir(join(root, 'job'), { recursive: true });
    await writeFile(file, 'image');
    const commands: string[][] = [];
    await openContainingFolder(root, file, {
      platform: 'linux',
      spawn: (command) => {
        commands.push(command);
        return {};
      }
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]?.[0]).toBe('xdg-open');
    expect(commands[0]?.[1]).toEndWith('/media/job');
  });
});
