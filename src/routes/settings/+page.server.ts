import { latestBalance } from '$lib/server/account/balance';
import { LibraryRepository } from '$lib/server/library/repository';
import { getPlatformServices } from '$lib/server/platform/runtime';
import {
  APP_VERSION,
  DATABASE_SCHEMA_VERSION,
  REGISTRY_SCHEMA_VERSION
} from '$lib/server/platform/version';
import { OperationsSettingsService } from '$lib/server/settings/operations-settings';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
  const platform = await getPlatformServices();
  const service = new OperationsSettingsService(
    platform.settings,
    platform.database,
    platform.logger
  );
  return {
    settings: service.dto(platform.paths, await platform.apiKey.status()),
    publicIpv4Guard: platform.publicIpv4.readSettings(),
    publicIpv4Status: await platform.publicIpv4.status(),
    connectivity: platform.apiKey.connectivityStatus(),
    mediaTools: await platform.mediaTools.getReadiness(),
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
