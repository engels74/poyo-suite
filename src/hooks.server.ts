import type { Handle } from '@sveltejs/kit';
import { getPlatformServices } from '$lib/server/platform/runtime';
import type { OperationsSettings } from '$lib/server/settings/operations-settings';
import { injectThemeDefault, isThemePreference, type ThemePreference } from '$lib/theme';

export async function init(): Promise<void> {
  const { startRuntimeJobWorker } = await import('$lib/server/jobs/runtime');
  const { startRuntimeCleanupWorker } = await import('$lib/server/cleanup/runtime');
  await Promise.all([startRuntimeJobWorker(), startRuntimeCleanupWorker()]);
}

async function installThemeDefault(): Promise<ThemePreference> {
  try {
    const platform = await getPlatformServices();
    const stored =
      platform.settings.get<OperationsSettings>('operations')?.value.theme?.defaultMode;
    return isThemePreference(stored) ? stored : 'light';
  } catch {
    // Settings unavailable (e.g. very early boot): fall back to light so the shell still renders.
    return 'light';
  }
}

// Seed the pre-hydration theme with the installation default so a brand-new browser (no stored
// preference yet) paints the configured theme immediately instead of flashing light → dark after
// hydration. `system` stays a preference that app.html resolves client-side via matchMedia.
export const handle: Handle = async ({ event, resolve }) => {
  let themeDefault: ThemePreference | null = null;
  return resolve(event, {
    // injectThemeDefault matches the <html> tag case-insensitively and no-ops on chunks without it,
    // so it is the single source of truth for the match. installThemeDefault is memoized, so the
    // settings read still happens at most once per request.
    transformPageChunk: async ({ html }) => {
      themeDefault ??= await installThemeDefault();
      return injectThemeDefault(html, themeDefault);
    }
  });
};
