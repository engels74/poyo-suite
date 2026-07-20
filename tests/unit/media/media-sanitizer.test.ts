import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, readlink, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MediaPrivacySettings } from '../../../src/lib/features/settings/contracts';
import {
  createMediaSanitizer,
  MediaSanitizationError,
  runMediaCommand
} from '../../../src/lib/server/media/media-sanitizer';
import { createTemporaryDirectory } from '../../helpers/temporary-directory';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

const defaults: MediaPrivacySettings = {
  sanitizeLocalMedia: true,
  removeExif: true,
  removeIptc: true,
  removeXmp: true,
  removePhotoshop8bim: true,
  removeColorProfile: false
};

async function temporary() {
  const directory = await createTemporaryDirectory('poyo-media-sanitizer-');
  cleanups.push(directory.cleanup);
  return directory.path;
}

describe('media command runner', () => {
  test('captures bounded output without a shell', async () => {
    const result = await runMediaCommand({
      cmd: ['bun', '-e', 'process.stdout.write("runner-ok")'],
      timeoutMs: 1_000,
      maxBufferBytes: 128
    });
    expect(new TextDecoder().decode(result.stdout)).toBe('runner-ok');
  });

  test.each([
    ['missing executable', ['poyo-definitely-missing-executable'], 1_000, 128],
    ['nonzero exit', ['bun', '-e', 'process.exit(7)'], 1_000, 128],
    ['timeout', ['bun', '-e', 'await Bun.sleep(500)'], 10, 128],
    ['output overflow', ['bun', '-e', 'process.stdout.write("x".repeat(4096))'], 1_000, 32]
  ])('returns one safe error for %s', async (_name, cmd, timeoutMs, maxBufferBytes) => {
    await expect(runMediaCommand({ cmd, timeoutMs, maxBufferBytes })).rejects.toEqual(
      new MediaSanitizationError()
    );
  });
});

describe('sanitizer output custody', () => {
  test('refuses pre-existing files, symlinks, and directories without invoking tools', async () => {
    const root = await temporary();
    const inputPath = join(root, 'input.png');
    const input = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(inputPath, input);
    const runnerCalls: string[][] = [];
    const sanitizer = createMediaSanitizer(async (mediaCommand) => {
      runnerCalls.push(mediaCommand.cmd);
      throw new Error('runner must not be called');
    });

    const existingFile = join(root, 'existing-file.png');
    const existingBytes = new TextEncoder().encode('existing output');
    await writeFile(existingFile, existingBytes);

    const symlinkTarget = join(root, 'symlink-target.png');
    const existingSymlink = join(root, 'existing-symlink.png');
    const targetBytes = new TextEncoder().encode('symlink target');
    await writeFile(symlinkTarget, targetBytes);
    await symlink(symlinkTarget, existingSymlink);

    const existingDirectory = join(root, 'existing-directory.png');
    const sentinel = join(existingDirectory, 'sentinel');
    const sentinelBytes = new TextEncoder().encode('directory sentinel');
    await mkdir(existingDirectory);
    await writeFile(sentinel, sentinelBytes);

    for (const outputPath of [existingFile, existingSymlink, existingDirectory]) {
      await expect(
        sanitizer({
          inputPath,
          outputPath,
          mimeType: 'image/png',
          mediaKind: 'image',
          settings: defaults,
          maxOutputBytes: 1024 * 1024
        })
      ).rejects.toBeInstanceOf(MediaSanitizationError);
    }

    expect(runnerCalls).toEqual([]);
    expect(await Bun.file(existingFile).bytes()).toEqual(existingBytes);
    expect(await readlink(existingSymlink)).toBe(symlinkTarget);
    expect(await Bun.file(symlinkTarget).bytes()).toEqual(targetBytes);
    expect(await Bun.file(sentinel).bytes()).toEqual(sentinelBytes);
  });

  test('fails safely when output-path inspection raises a non-ENOENT error', async () => {
    const root = await temporary();
    const inputPath = join(root, 'input.png');
    const regularParent = join(root, 'regular-parent');
    const parentBytes = new TextEncoder().encode('not a directory');
    await writeFile(inputPath, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await writeFile(regularParent, parentBytes);
    let runnerCalls = 0;
    const sanitizer = createMediaSanitizer(async () => {
      runnerCalls += 1;
      throw new Error('runner must not be called');
    });

    await expect(
      sanitizer({
        inputPath,
        outputPath: join(regularParent, 'output.png'),
        mimeType: 'image/png',
        mediaKind: 'image',
        settings: defaults,
        maxOutputBytes: 1024 * 1024
      })
    ).rejects.toBeInstanceOf(MediaSanitizationError);

    expect(runnerCalls).toBe(0);
    expect(await Bun.file(regularParent).bytes()).toEqual(parentBytes);
  });
});
