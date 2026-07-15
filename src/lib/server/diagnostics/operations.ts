import { REMOTE_CLEANUP_CAPABILITY } from '../../features/cleanup/contracts';
import type { CleanupRuntime } from '../cleanup/runtime';
import { LibraryRepository } from '../library/repository';
import type { PlatformServices } from '../platform/runtime';
import { OperationsSettingsService } from '../settings/operations-settings';
import { buildHealthDto } from './health';
import { redact } from './redaction';

export async function buildOperationsDiagnostics(
  platform: PlatformServices,
  cleanup: CleanupRuntime
): Promise<ReturnType<typeof redact>> {
  const apiKey = await platform.apiKey.status();
  const [health, logging, storage] = await Promise.all([
    buildHealthDto({ database: platform.database, apiKey, logger: platform.logger }),
    platform.logger.diagnostics(),
    new LibraryRepository(platform.database).storageStatistics(platform.paths)
  ]);
  const settings = new OperationsSettingsService(
    platform.settings,
    platform.database,
    platform.logger
  ).get();
  const registry = platform.database
    .query<{ version: string; verified_at: string; status: string }, []>(
      'SELECT version,verified_at,status FROM registry_versions ORDER BY verified_at DESC,version DESC'
    )
    .all();
  return redact({
    health,
    connectivity: platform.apiKey.connectivityStatus(),
    storage,
    cleanup: cleanup.diagnostics(),
    remoteCleanup: REMOTE_CLEANUP_CAPABILITY,
    registry,
    settings: {
      polling: settings.polling,
      downloads: settings.downloads,
      theme: settings.theme,
      logs: settings.logs,
      storageSource: platform.paths.source
    },
    logging
  });
}
