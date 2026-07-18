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
      await setup.manager.verifyConnectivity(async (resolved) => {
        expect(resolved.key).toBe('sk-test_local_canary_123456');
      });
      expect(setup.manager.connectivityStatus()).toEqual({
        checkedAt: '2026-07-15T12:00:00.000Z',
        status: 'ok'
      });
      expect(await setup.manager.removeLocal()).toMatchObject({
        source: 'none',
        status: 'missing'
      });
      expect(setup.manager.connectivityStatus()).toEqual({ checkedAt: null, status: null });
      expect((await setup.manager.resolve()).key).toBeNull();
    } finally {
      setup.database.close();
    }
  });

  test('serializes connectivity against key mutation and invalidates the completed result', async () => {
    const setup = await manager({});
    try {
      const firstKey = 'sk-test_first_connectivity_canary_123456';
      const secondKey = 'sk-test_second_connectivity_canary_123456';
      await setup.manager.setLocal(firstKey);

      let releaseProbe!: () => void;
      const probeRelease = new Promise<void>((resolve) => {
        releaseProbe = resolve;
      });
      let markProbeStarted!: () => void;
      const probeStarted = new Promise<void>((resolve) => {
        markProbeStarted = resolve;
      });
      const verification = setup.manager.verifyConnectivity(async (resolved) => {
        expect(resolved.key).toBe(firstKey);
        markProbeStarted();
        await probeRelease;
      });
      await probeStarted;

      const mutation = setup.manager.setLocal(secondKey);
      await Bun.sleep(5);
      expect(setup.store.value).toBe(firstKey);
      releaseProbe();
      await Promise.all([verification, mutation]);

      expect((await setup.manager.resolve()).key).toBe(secondKey);
      expect(setup.manager.connectivityStatus()).toEqual({ checkedAt: null, status: null });
    } finally {
      setup.database.close();
    }
  });

  test('records a failed probe without exposing or discarding the configured key', async () => {
    const setup = await manager({});
    try {
      const key = 'sk-test_failed_connectivity_canary_123456';
      await setup.manager.setLocal(key);
      await expect(
        setup.manager.verifyConnectivity(async (resolved) => {
          expect(resolved.key).toBe(key);
          throw new Error('synthetic connectivity failure');
        })
      ).rejects.toThrow('synthetic connectivity failure');
      expect(setup.manager.connectivityStatus()).toEqual({
        checkedAt: '2026-07-15T12:00:00.000Z',
        status: 'failed'
      });
      expect((await setup.manager.resolve()).key).toBe(key);
    } finally {
      setup.database.close();
    }
  });

  test('does not reuse persisted connectivity for a restarted or changed credential', async () => {
    const setup = await manager({});
    try {
      await setup.manager.setLocal('sk-test_restart_local_canary_123456');
      await setup.manager.verifyConnectivity(async () => undefined);
      expect(await setup.manager.connectivityVerified()).toBe(true);

      const restarted = new ApiKeyManager({
        environment: { POYO_API_KEY: 'sk-test_restart_environment_canary_123456' },
        secretStore: setup.store,
        metadataRepository: new SecretMetadataRepository(setup.database),
        now: () => new Date('2026-07-15T12:01:00.000Z')
      });
      expect(restarted.connectivityStatus()).toEqual({ checkedAt: null, status: null });
      expect((await restarted.status()).source).toBe('environment');
      expect(await restarted.connectivityVerified()).toBe(false);
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
