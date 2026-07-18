import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { CleanupRepository } from '../../../src/lib/server/cleanup/repository';
import { CleanupRuntime } from '../../../src/lib/server/cleanup/runtime';
import { CleanupService } from '../../../src/lib/server/cleanup/service';
import { StructuredLogger } from '../../../src/lib/server/diagnostics/jsonl-logger';
import { buildOperationsDiagnostics } from '../../../src/lib/server/diagnostics/operations';
import { openDatabase } from '../../../src/lib/server/platform/database';
import type { PlatformServices } from '../../../src/lib/server/platform/runtime';
import { DATABASE_SCHEMA_VERSION } from '../../../src/lib/server/platform/version';
import { SettingsRepository } from '../../../src/lib/server/settings/settings-repository';
import { createTemporaryDirectory } from '../../helpers/temporary-directory';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe('operations diagnostics', () => {
  test('DIAG-01 exposes schema, storage, cleanup and connectivity without paths or secrets', async () => {
    const temporary = await createTemporaryDirectory('poyo-diagnostics-');
    cleanups.push(temporary.cleanup);
    const database = await openDatabase(join(temporary.path, 'studio.sqlite'));
    const paths = {
      root: temporary.path,
      database: join(temporary.path, 'studio.sqlite'),
      media: temporary.path,
      uploads: join(temporary.path, 'uploads'),
      thumbnails: join(temporary.path, 'thumbnails'),
      logs: join(temporary.path, 'logs'),
      secrets: join(temporary.path, 'secrets'),
      temporary: join(temporary.path, 'tmp'),
      source: 'project-default' as const,
      rootKind: 'project' as const
    };
    const logger = new StructuredLogger({ directory: paths.logs });
    const sentinel = 'sk-test_diagnostics_canary_123456';
    await logger.info('diagnostics.fixture', { data: { apiKey: sentinel } });
    const platform = {
      paths,
      database,
      settings: new SettingsRepository(database),
      logger,
      apiKey: {
        status: () =>
          Promise.resolve({
            source: 'local' as const,
            status: 'configured' as const,
            storeKind: 'os' as const,
            onboardingAvailable: true,
            environmentManaged: false,
            updatedAt: '2026-07-15T12:00:00.000Z'
          }),
        connectivityStatus: () => ({
          checkedAt: '2026-07-15T12:00:00.000Z',
          status: `ok ${sentinel}`
        })
      }
    } as unknown as PlatformServices;
    const repository = new CleanupRepository(database);
    const cleanup = new CleanupRuntime({
      repository,
      service: new CleanupService({ repository, paths })
    });

    try {
      const diagnostics = await buildOperationsDiagnostics(platform, cleanup);
      const json = JSON.stringify(diagnostics);
      expect(json).not.toContain(sentinel);
      expect(json).not.toContain(temporary.path);
      expect(diagnostics).toMatchObject({
        connectivity: { status: 'ok [REDACTED]' },
        remoteCleanup: { available: false, verifiedAt: '2026-07-15' },
        health: {
          database: { schemaVersion: DATABASE_SCHEMA_VERSION },
          apiKey: {
            source: 'local',
            status: 'configured',
            storeKind: 'os',
            onboardingAvailable: true,
            environmentManaged: false
          }
        }
      });
    } finally {
      database.close();
    }
  });
});
