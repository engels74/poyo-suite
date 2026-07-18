import { operationsHttpError } from '$lib/server/operations/http';
import { getPlatformServices } from '$lib/server/platform/runtime';
import { readSameOriginJson } from '$lib/server/platform/request-security';
import { CredentialBackendError } from '$lib/server/settings/api-key-manager';
import { loadOnboardingState } from '$lib/server/settings/onboarding-gate';
import { updateOnboarding, type OnboardingUpdate } from '$lib/server/settings/studio-settings';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ setHeaders }) => {
  setHeaders({ 'cache-control': 'no-store' });
  const platform = await getPlatformServices();
  return Response.json({ onboarding: await loadOnboardingState(platform) });
};

export const PUT: RequestHandler = async ({ request }) => {
  try {
    const body = await readSameOriginJson<OnboardingUpdate>(request, { maxBytes: 4 * 1024 });
    const platform = await getPlatformServices();
    const requiresVerifiedConnection =
      body.steps?.connection === true || body.complete === true || body.dismiss === true;
    if (requiresVerifiedConnection) {
      const apiKey = await platform.apiKey.status();
      if (apiKey.status !== 'configured' || !(await platform.apiKey.connectivityVerified())) {
        throw new CredentialBackendError(
          'verification_failed',
          'Store an API key and successfully test the connection before completing setup.'
        );
      }
    }
    updateOnboarding(platform.settings, {
      ...(body.steps ? { steps: body.steps } : {}),
      complete: body.complete === true,
      dismiss: body.dismiss === true,
      reopen: body.reopen === true
    });
    return Response.json({ onboarding: await loadOnboardingState(platform) });
  } catch (error) {
    return operationsHttpError(error);
  }
};
