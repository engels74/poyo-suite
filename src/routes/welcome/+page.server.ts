import { getPlatformServices } from '$lib/server/platform/runtime';
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
  return {
    settings: service.dto(platform.paths, await platform.apiKey.status()),
    onboarding: await loadOnboardingState(platform),
    connectivity: platform.apiKey.connectivityStatus(),
    mediaTools: await platform.mediaTools.getReadiness()
  };
};
