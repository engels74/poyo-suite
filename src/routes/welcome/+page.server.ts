import { getPlatformServices } from '$lib/server/platform/runtime';
import { resolveAppPathCandidates } from '$lib/server/platform/app-paths';
import { maintenanceGate } from '$lib/server/platform/maintenance-gate';
import { storageRootStatusDto } from '$lib/server/platform/root-status';
import { loadOnboardingState } from '$lib/server/settings/onboarding-gate';
import { OperationsSettingsService } from '$lib/server/settings/operations-settings';
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
    onboarding: await loadOnboardingState(platform)
  };
};
