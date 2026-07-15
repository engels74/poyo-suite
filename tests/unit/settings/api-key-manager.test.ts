import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { openDatabase } from '../../../src/lib/server/platform/database';
import {
  ApiKeyManager,
  EnvironmentKeyActiveError
} from '../../../src/lib/server/settings/api-key-manager';
import { SecretMetadataRepository } from '../../../src/lib/server/settings/secret-metadata-repository';
import type { SecretStore } from '../../../src/lib/server/settings/secret-store';
import { SettingsRepository } from '../../../src/lib/server/settings/settings-repository';
import { createTemporaryDirectory } from '../../helpers/temporary-directory';

class MemorySecretStore implements SecretStore {
  readonly kind = 'os' as const;
  getCalls = 0;

  constructor(public value: string | null = null) {}

  checkAvailability(): Promise<boolean> {
    return Promise.resolve(true);
  }

  get(): Promise<string | null> {
    this.getCalls += 1;
    return Promise.resolve(this.value);
  }

  set(secret: string): Promise<void> {
    this.value = secret;
    return Promise.resolve();
  }

  delete(): Promise<boolean> {
    const existed = this.value !== null;
    this.value = null;
    return Promise.resolve(existed);
  }
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function manager(
  environment: Record<string, string | undefined>,
  store = new MemorySecretStore()
) {
  const temporary = await createTemporaryDirectory('poyo-key-');
  cleanups.push(temporary.cleanup);
  const path = join(temporary.path, 'studio.sqlite');
  const database = await openDatabase(path);
  return {
    path,
    database,
    store,
    manager: new ApiKeyManager({
      environment,
      secretStore: store,
      metadataRepository: new SecretMetadataRepository(database),
      now: () => new Date('2026-07-15T12:00:00.000Z')
    })
  };
}

describe('API key configuration', () => {
  test('SET-01 gives the environment key absolute precedence', async () => {
    const environmentSecret = ['sk', 'test_environment_canary_123456'].join('-');
    const setup = await manager(
      { POYO_API_KEY: environmentSecret },
      new MemorySecretStore('local')
    );
    try {
      const resolved = await setup.manager.resolve();
      expect(resolved.key).toBe(environmentSecret);
      expect(resolved.status).toMatchObject({
        source: 'environment',
        status: 'configured',
        environmentManaged: true,
        onboardingAvailable: false
      });
      expect(setup.store.getCalls).toBe(0);
      await expect(setup.manager.setLocal('sk-test_other_canary_123456')).rejects.toBeInstanceOf(
        EnvironmentKeyActiveError
      );
    } finally {
      setup.database.close();
    }
  });

  test('supports local onboarding and removal when environment configuration is absent', async () => {
    const setup = await manager({});
    try {
      expect((await setup.manager.resolve()).status.status).toBe('missing');
      expect(await setup.manager.setLocal('sk-test_local_canary_123456')).toMatchObject({
        source: 'local',
        status: 'configured',
        onboardingAvailable: true
      });
      expect((await setup.manager.resolve()).key).toBe('sk-test_local_canary_123456');
      setup.manager.recordConnectivity('ok');
      expect(setup.manager.connectivityStatus()).toEqual({
        checkedAt: '2026-07-15T12:00:00.000Z',
        status: 'ok'
      });
      expect(await setup.manager.removeLocal()).toMatchObject({
        source: 'none',
        status: 'missing'
      });
      expect((await setup.manager.resolve()).key).toBeNull();
    } finally {
      setup.database.close();
    }
  });

  test('SET-02 and DB-06 never persist API key material in SQLite settings or metadata', async () => {
    const sentinel = 'sk-test_database_leak_canary_123456789';
    const setup = await manager({});
    try {
      await setup.manager.setLocal(sentinel);
      const settings = new SettingsRepository(setup.database);
      expect(() => settings.set('api_key', sentinel)).toThrow();
      expect(() => settings.set('appearance', { nestedToken: sentinel })).toThrow();
      setup.database.query('PRAGMA wal_checkpoint(TRUNCATE)').run();
    } finally {
      setup.database.close();
    }

    const bytes = await Bun.file(setup.path).arrayBuffer();
    expect(new TextDecoder().decode(bytes)).not.toContain(sentinel);
  });
});
