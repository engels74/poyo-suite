import type { OnboardingStateDto } from '../../features/settings/contracts';
import type { PlatformServices } from '../platform/runtime';
import { computeOnboardingState, readOnboarding } from './studio-settings';

/**
 * Resolve onboarding completion, combining the stored marker with install context so existing
 * installs with history remain compatible while an otherwise-fresh key must be verified.
 */
export async function loadOnboardingState(platform: PlatformServices): Promise<OnboardingStateDto> {
  const apiKeyStatus = await platform.apiKey.status();
  const history =
    platform.database
      .query<{ count: number }, []>(
        'SELECT (SELECT COUNT(*) FROM jobs) + (SELECT COUNT(*) FROM job_outputs) AS count'
      )
      .get()?.count ?? 0;
  return computeOnboardingState(readOnboarding(platform.settings), {
    apiKeyConfigured: apiKeyStatus.status === 'configured',
    connectionVerified: await platform.apiKey.connectivityVerified(),
    hasHistory: history > 0
  });
}
