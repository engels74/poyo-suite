import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createPreferredSecretStore,
  OsSecretStore,
  parseMacOsSecuritySecretOutput,
  PermissionFileSecretStore,
  type PermissionFileSecretStoreCheckpoint,
  type BunSecretsApi
} from '../../../src/lib/server/settings/secret-store';
import { createTemporaryDirectory } from '../../helpers/temporary-directory';

const unavailableOsStore: BunSecretsApi = {
  get: () => Promise.reject(new Error('credential service unavailable')),
  set: () => Promise.reject(new Error('credential service unavailable')),
  delete: () => Promise.reject(new Error('credential service unavailable'))
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

describe('secret store selection', () => {
  test('uses a 0700/0600 file backend without probing the available OS store', async () => {
    const temporary = await createTemporaryDirectory('poyo-secret-');
    cleanups.push(temporary.cleanup);
    const directory = join(temporary.path, 'secrets');
    const store = await createPreferredSecretStore({
      paths: { secrets: directory },
      platform: 'linux',
      bunSecrets: unavailableOsStore
    });

    expect(store.kind).toBe('file');
    expect(await store.checkAvailability()).toBe(true);
    await store.set('sk-test_permission_canary_123456');
    expect(await store.get()).toBe('sk-test_permission_canary_123456');
    expect((await lstat(directory)).mode & 0o077).toBe(0);
    expect((await lstat(join(directory, 'poyo-api-key'))).mode & 0o077).toBe(0);
    expect(await store.delete()).toBe(true);
  });

  test('observes a missing permission-file credential without creating or repairing storage', async () => {
    const temporary = await createTemporaryDirectory('poyo-secret-observe-');
    cleanups.push(temporary.cleanup);
    const directory = join(temporary.path, 'secrets');
    const store = new PermissionFileSecretStore(directory, 'linux');

    expect(await store.get()).toBeNull();
    expect(await pathExists(directory)).toBe(false);

    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o755);
    await expect(store.get()).rejects.toThrow('permissions are not private');
    expect((await lstat(directory)).mode & 0o777).toBe(0o755);
  });

  test('makes permission-file writes and deletes durable before reporting success', async () => {
    const temporary = await createTemporaryDirectory('poyo-secret-durable-');
    cleanups.push(temporary.cleanup);
    const directory = join(temporary.path, 'secrets');
    const checkpoints: PermissionFileSecretStoreCheckpoint[] = [];
    const store = new PermissionFileSecretStore(directory, 'linux', {
      checkpoint: (checkpoint) => {
        checkpoints.push(checkpoint);
      }
    });

    await store.set('sk-test_durable_permission_file_123456');
    expect(checkpoints).toEqual([
      'directory-created',
      'parent-directory-synced',
      'temporary-opened',
      'temporary-written',
      'temporary-synced',
      'target-renamed',
      'directory-synced'
    ]);
    expect(await store.get()).toBe('sk-test_durable_permission_file_123456');

    expect(await store.delete()).toBe(true);
    expect(checkpoints.slice(-2)).toEqual(['target-deleted', 'delete-directory-synced']);
    expect(await pathExists(join(directory, 'poyo-api-key'))).toBe(false);
  });

  test('surfaces durability-boundary failures and cleans exclusive temporary files', async () => {
    const temporary = await createTemporaryDirectory('poyo-secret-fsync-failure-');
    cleanups.push(temporary.cleanup);
    const directory = join(temporary.path, 'secrets');
    const target = join(directory, 'poyo-api-key');
    const beforeParentSync = new PermissionFileSecretStore(directory, 'linux', {
      checkpoint: (checkpoint) => {
        if (checkpoint === 'parent-directory-synced') {
          throw new Error('injected parent directory fsync failure');
        }
      }
    });
    await expect(beforeParentSync.set('sk-test_parent_not_durable_123456')).rejects.toThrow(
      'injected parent directory fsync failure'
    );
    expect(await pathExists(target)).toBe(false);

    const beforeFileSync = new PermissionFileSecretStore(directory, 'linux', {
      checkpoint: (checkpoint) => {
        if (checkpoint === 'temporary-written') throw new Error('injected file fsync failure');
      }
    });
    await expect(beforeFileSync.set('sk-test_never_durable_123456')).rejects.toThrow(
      'injected file fsync failure'
    );
    expect(await pathExists(target)).toBe(false);
    expect(await readdir(directory)).toEqual([]);

    const beforeRenameSync = new PermissionFileSecretStore(directory, 'linux', {
      checkpoint: (checkpoint) => {
        if (checkpoint === 'target-renamed') throw new Error('injected directory fsync failure');
      }
    });
    await expect(beforeRenameSync.set('sk-test_renamed_not_committed_123456')).rejects.toThrow(
      'injected directory fsync failure'
    );
    expect(await Bun.file(target).text()).toBe('sk-test_renamed_not_committed_123456');

    const beforeDeleteSync = new PermissionFileSecretStore(directory, 'linux', {
      checkpoint: (checkpoint) => {
        if (checkpoint === 'target-deleted') throw new Error('injected delete fsync failure');
      }
    });
    await expect(beforeDeleteSync.delete()).rejects.toThrow('injected delete fsync failure');
    expect(await pathExists(target)).toBe(false);
  });

  test('keeps file selected but unavailable on Windows instead of silently selecting OS', async () => {
    const temporary = await createTemporaryDirectory('poyo-secret-win-');
    cleanups.push(temporary.cleanup);
    const store = await createPreferredSecretStore({
      paths: { secrets: join(temporary.path, 'secrets') },
      platform: 'win32',
      bunSecrets: unavailableOsStore
    });

    expect(store.kind).toBe('file');
    expect(await store.checkAvailability()).toBe(false);
    await expect(store.set('sk-test_never_written_123456')).rejects.toThrow('unavailable');
  });

  test('treats a non-interactive macOS security prompt glyph as unavailable', async () => {
    expect(() => parseMacOsSecuritySecretOutput('∙')).toThrow('unavailable');
    expect(parseMacOsSecuritySecretOutput('  sk-test_real_value  ')).toBe('sk-test_real_value');

    const store = new OsSecretStore({
      get: () => Promise.resolve('∙'),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(false)
    });
    expect(await store.checkAvailability()).toBe(false);
    await expect(store.get()).rejects.toThrow('unavailable');
  });
});
