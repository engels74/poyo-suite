import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { openDatabase } from '../../../src/lib/server/platform/database';
import { ApiKeyManager } from '../../../src/lib/server/settings/api-key-manager';
import { SecretMetadataRepository } from '../../../src/lib/server/settings/secret-metadata-repository';
import {
  type BunSecretsApi,
  createPreferredSecretStore
} from '../../../src/lib/server/settings/secret-store';
import { computeOnboardingState } from '../../../src/lib/server/settings/studio-settings';
import { createTemporaryDirectory } from '../../helpers/temporary-directory';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('credential backend opt-in', () => {
  test('does not select a stale OS credential or let it bypass fresh-install onboarding', async () => {
    const temporary = await createTemporaryDirectory('poyo-stale-os-key-');
    cleanups.push(temporary.cleanup);
    const database = await openDatabase(join(temporary.path, 'studio.sqlite'));
    cleanups.push(() => database.close());
    const staleOsCredential: BunSecretsApi = {
      get: () => Promise.resolve('sk-test_stale_unselected_os_credential'),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(true)
    };
    const store = await createPreferredSecretStore({
      paths: { secrets: join(temporary.path, 'secrets') },
      platform: 'darwin',
      bunSecrets: staleOsCredential
    });
    const manager = new ApiKeyManager({
      environment: {},
      secretStore: store,
      metadataRepository: new SecretMetadataRepository(database)
    });
    const status = await manager.status();
    const onboarding = computeOnboardingState(null, {
      apiKeyConfigured: status.status === 'configured',
      hasHistory: false
    });

    expect({ storeKind: store.kind, onboarding }).toEqual({
      storeKind: 'file',
      onboarding: {
        completed: false,
        completedAt: null,
        dismissedAt: null,
        version: 1,
        steps: { location: false, connection: false, theme: false, defaults: false },
        inferred: false
      }
    });
  });
});
