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
