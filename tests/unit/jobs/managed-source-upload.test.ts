import { afterEach, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createManagedSourceUploadRefresher } from '../../../src/lib/server/jobs/managed-source-upload';
import { ManagedSourceRepository } from '../../../src/lib/server/media/managed-sources';
import { ensureAppPaths, resolveAppPaths } from '../../../src/lib/server/platform/app-paths';
import { openDatabase } from '../../../src/lib/server/platform/database';
import { PublicIpv4Service } from '../../../src/lib/server/platform/public-ipv4';
import type { PlatformServices } from '../../../src/lib/server/platform/runtime';
import { SettingsRepository } from '../../../src/lib/server/settings/settings-repository';
import { startStudioMockPoyoServer } from '../../helpers/studio-mock-poyo-server';
import { createTemporaryDirectory } from '../../helpers/temporary-directory';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test('managed-source refresh upload is blocked before the upload reaches Poyo', async () => {
  const temporary = await createTemporaryDirectory('managed-source-guard-');
  const mock = await startStudioMockPoyoServer();
  cleanups.push(temporary.cleanup, mock.stop);
  const paths = resolveAppPaths({
    environment: { PLS_APP_DATA_DIR: join(temporary.path, 'studio') }
  });
  await ensureAppPaths(paths);
  const database = await openDatabase(paths.database);
  cleanups.push(() => database.close());

  const id = crypto.randomUUID();
  const bytes = await Bun.file('tests/fixtures/media/tiny.png').bytes();
  const localPath = join(paths.uploads, `${id}.png`);
  await mkdir(paths.uploads, { recursive: true });
  await writeFile(localPath, bytes);
  const checksum = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  const signature = Array.from(bytes.subarray(0, Math.min(16, bytes.byteLength)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  await new ManagedSourceRepository(database, paths).register({
    id,
    originalName: 'private-name.png',
    mediaKind: 'image',
    mimeType: 'image/png',
    sizeBytes: bytes.byteLength,
    checksum,
    signature,
    createdAt: '2026-07-19T00:00:00.000Z',
    localPath
  });

  const settings = new SettingsRepository(database);
  const publicIpv4 = new PublicIpv4Service({ settings, lookupUrl: `${mock.baseUrl}/ip` });
  publicIpv4.saveSettings({ enabled: true, homeIpv4: '8.8.4.4' });
  const platform = {
    environment: {
      PLS_TEST_MODE: '1',
      PLS_TEST_POYO_BASE_URL: mock.baseUrl
    },
    paths,
    database,
    settings,
    apiKey: {
      resolve: async () => ({
        key: ['sk', 'managed_source_guard_123456'].join('-'),
        status: {
          source: 'local',
          status: 'configured',
          storeKind: 'file',
          onboardingAvailable: true,
          environmentManaged: false,
          localMutationAvailable: true,
          updatedAt: '2026-07-19T00:00:00.000Z'
        }
      })
    },
    logger: undefined,
    publicIpv4
  } as unknown as PlatformServices;

  await expect(createManagedSourceUploadRefresher(platform)(id, 'image')).rejects.toMatchObject({
    category: 'policy',
    technicalCode: 'public_ipv4_guard_match',
    operation: 'upload_stream'
  });
  expect(mock.requests).toHaveLength(0);
  expect(mock.ipRequests).toEqual(['/ip']);
});
