import { env } from '$env/dynamic/private';
import { latestBalance } from '$lib/server/account/balance';
import { LibraryRepository } from '$lib/server/library/repository';
import { resolveAppPathCandidates } from '$lib/server/platform/app-paths';
import { getPlatformServices } from '$lib/server/platform/runtime';
import { maintenanceGate } from '$lib/server/platform/maintenance-gate';
import { storageRootStatusDto } from '$lib/server/platform/root-status';
import {
  APP_VERSION,
  DATABASE_SCHEMA_VERSION,
  REGISTRY_SCHEMA_VERSION
} from '$lib/server/platform/version';
import { OperationsSettingsService } from '$lib/server/settings/operations-settings';
import { outputLocationDto, readStoragePreferences } from '$lib/server/settings/studio-settings';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
  const platform = await getPlatformServices();
  const service = new OperationsSettingsService(
    platform.settings,
    platform.database,
    platform.logger
  );
  const rootCandidates = resolveAppPathCandidates({ environment: platform.environment });
  return {
    settings: service.dto(platform.paths, await platform.apiKey.status()),
    storageRoot: await storageRootStatusDto({
      paths: platform.paths,
      runtime: platform.storageRootRuntime,
      gate: maintenanceGate,
      database: platform.database,
      candidateRoots: [rootCandidates.project.root, rootCandidates.platform.root],
      environment: platform.environment
    }),
    outputLocation: outputLocationDto(
      platform.paths,
      readStoragePreferences(platform.settings),
      Boolean(env.PLS_MEDIA_DIR?.trim())
    ),
    connectivity: platform.apiKey.connectivityStatus(),
    balance: latestBalance(platform.database),
    storage: await new LibraryRepository(platform.database).storageStatistics(platform.paths),
    registry: platform.database
      .query<{ version: string; verifiedAt: string; status: string }, []>(
        'SELECT version,verified_at verifiedAt,status FROM registry_versions ORDER BY verified_at DESC,version DESC'
      )
      .all(),
    versions: {
      application: APP_VERSION,
      databaseSchema: DATABASE_SCHEMA_VERSION,
      registrySchema: REGISTRY_SCHEMA_VERSION
    }
  };
};
