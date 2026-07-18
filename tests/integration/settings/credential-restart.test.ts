import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { openDatabase } from '../../../src/lib/server/platform/database';
import { ApiKeyManager } from '../../../src/lib/server/settings/api-key-manager';
import { CredentialStateRepository } from '../../../src/lib/server/settings/credential-state';
import { SecretMetadataRepository } from '../../../src/lib/server/settings/secret-metadata-repository';
import {
  PermissionFileSecretStore,
  type SecretStore
} from '../../../src/lib/server/settings/secret-store';
import { SettingsRepository } from '../../../src/lib/server/settings/settings-repository';
import { createTemporaryDirectory } from '../../helpers/temporary-directory';

class RestartPersistentOsStore implements SecretStore {
  readonly kind = 'os' as const;

  constructor(private readonly path: string) {}

  checkAvailability(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async get(): Promise<string | null> {
    if (!(await Bun.file(this.path).exists())) return null;
    return (await Bun.file(this.path).text()) || null;
  }

  async set(secret: string): Promise<void> {
    await Bun.write(this.path, secret, { mode: 0o600 });
    await chmod(this.path, 0o600);
  }

  async delete(): Promise<boolean> {
    if (!(await Bun.file(this.path).exists())) return false;
    await unlink(this.path);
    return true;
  }
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('credential transition restart recovery', () => {
  test('resumes a durable target-written transition after closing and reopening SQLite', async () => {
    const temporary = await createTemporaryDirectory('poyo-credential-restart-');
    cleanups.push(temporary.cleanup);
    const databasePath = join(temporary.path, 'studio.sqlite');
    const fileStore = new PermissionFileSecretStore(join(temporary.path, 'secrets'), 'darwin');
    const osStore = new RestartPersistentOsStore(join(temporary.path, 'os-store-fixture'));
    const key = 'sk-test_restart_process_boundary_123456';

    const firstDatabase = await openDatabase(databasePath);
    await fileStore.set(key);
    await osStore.set(key);
    new CredentialStateRepository(new SettingsRepository(firstDatabase)).save({
      selectedBackend: 'file',
      transition: {
        id: 'restart-target-written',
        sourceBackend: 'file',
        targetBackend: 'os',
        phase: 'target-written',
        targetOwnership: 'absent'
      }
    });
    firstDatabase.query('PRAGMA wal_checkpoint(TRUNCATE)').run();
    firstDatabase.close();

    const restartedDatabase = new Database(databasePath, { strict: true });
    cleanups.push(() => restartedDatabase.close());
    const settings = new SettingsRepository(restartedDatabase);
    const manager = new ApiKeyManager({
      environment: {},
      secretStores: { file: fileStore, os: osStore },
      metadataRepository: new SecretMetadataRepository(restartedDatabase),
      settingsRepository: settings
    });
    await manager.initialize();

    expect(await manager.status()).toMatchObject({
      selectedBackend: 'file',
      transition: {
        phase: 'target-written',
        conflict: 'pre-authority-recovery-required',
        actions: expect.arrayContaining(['resume-transition'])
      }
    });
    expect(await fileStore.get()).toBe(key);
    expect(await osStore.get()).toBe(key);

    await manager.resolveTransitionConflict('resume-transition');
    expect(await fileStore.get()).toBeNull();
    expect(await osStore.get()).toBe(key);
    expect(new CredentialStateRepository(settings).get()).toMatchObject({
      selectedBackend: 'os',
      transition: { phase: 'complete' }
    });
    expect((await lstat(join(temporary.path, 'secrets'))).mode & 0o077).toBe(0);
    expect((await lstat(join(temporary.path, 'os-store-fixture'))).mode & 0o077).toBe(0);
  });
});
