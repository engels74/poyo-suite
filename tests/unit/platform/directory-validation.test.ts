import { afterEach, describe, expect, test } from 'bun:test';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateOutputDirectory } from '../../../src/lib/server/platform/directory-validation';
import { createTemporaryDirectory } from '../../helpers/temporary-directory';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

async function temp(): Promise<string> {
  const dir = await createTemporaryDirectory('poyo-dirvalidate-');
  cleanups.push(dir.cleanup);
  return dir.path;
}

describe('validateOutputDirectory', () => {
  test('rejects an empty value', async () => {
    const result = await validateOutputDirectory('   ');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('empty');
  });

  test('rejects a null byte', async () => {
    const result = await validateOutputDirectory('/tmp/a\0b');
    expect(result.code).toBe('null_byte');
  });

  test('rejects a relative path', async () => {
    const result = await validateOutputDirectory('relative/media');
    expect(result.code).toBe('not_absolute');
  });

  test('accepts an existing writable directory and reports free space', async () => {
    const dir = await temp();
    const result = await validateOutputDirectory(dir);
    expect(result.ok).toBe(true);
    expect(result.code).toBe('ok');
    expect(result.existed).toBe(true);
    expect(result.created).toBe(false);
    expect(result.freeBytes === null || result.freeBytes > 0).toBe(true);
  });

  test('creates a missing directory when the parent is writable', async () => {
    const dir = await temp();
    const target = join(dir, 'nested', 'media');
    const result = await validateOutputDirectory(target);
    expect(result.ok).toBe(true);
    expect(result.created).toBe(true);
    expect(result.path).toBe(target);
  });

  test('rejects a path that is a file', async () => {
    const dir = await temp();
    const file = join(dir, 'not-a-folder.txt');
    await writeFile(file, 'x');
    const result = await validateOutputDirectory(file);
    expect(result.code).toBe('not_a_directory');
  });

  test('rejects a symbolic link', async () => {
    const dir = await temp();
    const link = join(dir, 'link');
    await symlink(dir, link);
    const result = await validateOutputDirectory(link);
    expect(result.code).toBe('symlink');
  });

  test('preserves an existing user file that shares the probe name', async () => {
    const dir = await temp();
    const clash = join(dir, '.poyo-write-check');
    await writeFile(clash, 'user data');
    const result = await validateOutputDirectory(dir);
    expect(result.ok).toBe(true);
    // The write probe must never overwrite or delete a user file, even one named like the probe.
    expect(await readFile(clash, 'utf8')).toBe('user data');
  });

  test('returns a structured result instead of throwing when the path cannot be stat-ed', async () => {
    const dir = await temp();
    // A path component far longer than NAME_MAX makes lstat throw ENAMETOOLONG; validation must
    // surface a structured result rather than propagating the error as a server fault.
    const target = join(dir, 'x'.repeat(5000));
    const result = await validateOutputDirectory(target);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('not_writable');
  });
});
