import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { StructuredLogger } from '../../../src/lib/server/diagnostics/jsonl-logger';
import { openDatabase } from '../../../src/lib/server/platform/database';
import {
  DEFAULT_OPERATIONS_SETTINGS,
  OperationsSettingsService
} from '../../../src/lib/server/settings/operations-settings';
import { SettingsRepository } from '../../../src/lib/server/settings/settings-repository';
import { createTemporaryDirectory } from '../../helpers/temporary-directory';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe('validated operations settings', () => {
  test('persists bounded public settings, light default and applies logger rotation at runtime', async () => {
    const temporary = await createTemporaryDirectory('poyo-operations-');
    cleanups.push(temporary.cleanup);
    const database = await openDatabase(join(temporary.path, 'studio.sqlite'));
    try {
      const logger = new StructuredLogger({ directory: join(temporary.path, 'logs') });
      const service = new OperationsSettingsService(
        new SettingsRepository(database),
        database,
        logger
      );
      expect(service.get()).toEqual(DEFAULT_OPERATIONS_SETTINGS);
      const cleanupRows = () =>
        database.query<{ count: number }, []>('SELECT COUNT(*) count FROM cleanup_policies').get()
          ?.count ?? 0;
      expect(cleanupRows()).toBe(0);
      service.dto(
        {
          root: temporary.path,
          database: join(temporary.path, 'studio.sqlite'),
          media: join(temporary.path, 'media'),
          uploads: join(temporary.path, 'uploads'),
          thumbnails: join(temporary.path, 'thumbnails'),
          logs: join(temporary.path, 'logs'),
          secrets: join(temporary.path, 'secrets'),
          temporary: join(temporary.path, 'tmp'),
          source: 'project-default',
          rootKind: 'project'
        },
        {
          source: 'none',
          status: 'missing',
          storeKind: 'file',
          selectedBackend: 'file',
          backendAvailability: { file: 'available', os: 'unchecked' },
          transition: null,
          onboardingAvailable: true,
          environmentManaged: false,
          localMutationAvailable: true,
          updatedAt: null
        }
      );
      expect(cleanupRows()).toBe(0);
      const operations = {
        polling: { intervalMs: 10_000, staleAfterMs: 600_000 },
        downloads: { automatic: false },
        logs: {
          separateErrorFile: false,
          maxBytes: 128 * 1024,
          maxAgeMs: 60_000,
          retentionAgeMs: 3_600_000,
          maxRotatedFiles: 3
        },
        theme: { defaultMode: 'dark' as const }
      };
      service.update({
        operations,
        localCleanup: {
          mode: 'never',
          exclusions: { favorites: true, pinned: true, tags: [] }
        }
      });
      expect(service.get()).toEqual(operations);
      expect(logger.rotationSettings()).toEqual(operations.logs);
      const publicSettings = service.dto(
        {
          root: temporary.path,
          database: join(temporary.path, 'studio.sqlite'),
          media: join(temporary.path, 'media'),
          uploads: join(temporary.path, 'uploads'),
          thumbnails: join(temporary.path, 'thumbnails'),
          logs: join(temporary.path, 'logs'),
          secrets: join(temporary.path, 'secrets'),
          temporary: join(temporary.path, 'tmp'),
          source: 'project-default',
          rootKind: 'project'
        },
        {
          source: 'none',
          status: 'missing',
          storeKind: 'file',
          selectedBackend: 'file',
          backendAvailability: { file: 'available', os: 'unchecked' },
          transition: null,
          onboardingAvailable: true,
          environmentManaged: false,
          localMutationAvailable: true,
          updatedAt: null
        }
      );
      expect(publicSettings.storage).toEqual({ source: 'project-default' });
      expect(JSON.stringify(publicSettings)).not.toContain(temporary.path);
      expect(() =>
        service.update({
          operations: { ...operations, polling: { intervalMs: 0, staleAfterMs: 1 } }
        })
      ).toThrow('supported range');
    } finally {
      database.close();
    }
  });
});
