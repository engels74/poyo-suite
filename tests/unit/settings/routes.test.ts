import { describe, expect, test } from 'bun:test';

describe('settings HTTP and page boundaries', () => {
  test('SEC-04 every settings and cleanup mutation uses same-origin bounded JSON', async () => {
    for (const route of [
      'src/routes/api/settings/+server.ts',
      'src/routes/api/settings/api-key/+server.ts',
      'src/routes/api/settings/api-key/connectivity/+server.ts',
      'src/routes/api/settings/public-ipv4-guard/+server.ts',
      'src/routes/api/public-ipv4/+server.ts',
      'src/routes/api/settings/logs/+server.ts',
      'src/routes/api/onboarding/+server.ts',
      'src/routes/api/cleanup/preview/+server.ts',
      'src/routes/api/cleanup/apply/+server.ts'
    ]) {
      expect(await Bun.file(route).text()).toContain('readSameOriginJson');
    }
  });

  test('public IPv4 guard remains focused and shell-safe', async () => {
    const layout = await Bun.file('src/routes/+layout.server.ts').text();
    const settingsLoad = await Bun.file('src/routes/settings/+page.server.ts').text();
    const shell = await Bun.file('src/lib/components/shell/AppShell.svelte').text();
    const settingsPage = await Bun.file('src/routes/settings/+page.svelte').text();
    const route = await Bun.file('src/routes/api/settings/public-ipv4-guard/+server.ts').text();
    expect(layout).toContain('publicIpv4Status');
    expect(layout).not.toContain('homeIpv4');
    expect(settingsLoad).toContain('publicIpv4Guard');
    expect(shell).toContain('await invalidateAll()');
    expect(settingsPage).toContain('data.publicIpv4Status');
    expect(route).toContain('saveSettings(body)');
    expect(route).toContain('operationsHttpError');
  });

  test('production smoke verifies connectivity before onboarding dismissal', async () => {
    const smoke = await Bun.file('scripts/production-smoke.ts').text();
    expect(smoke).not.toContain('updateOnboarding');
    expect(smoke).not.toContain('SettingsRepository');
    expect(smoke.indexOf('/api/settings/api-key/connectivity')).toBeLessThan(
      smoke.indexOf('/api/onboarding')
    );
  });

  test('log deletion is explicitly confirmed, drained, path-free, and recoverable', async () => {
    const route = await Bun.file('src/routes/api/settings/logs/+server.ts').text();
    expect(route).toContain('body.confirmed !== true');
    expect(route).toContain('upgradeToExclusiveMaintenance');
    expect(route).toContain('clearManagedFiles');
    expect(route).toContain('resumeBeforePublication');
    expect(route).toContain('reopenBeforePublication');
    expect(route).not.toContain('platform.paths.logs');
    expect(await Bun.file('src/lib/server/jobs/runtime.ts').text()).not.toContain(
      "registerDrain('job-worker'"
    );
    expect(await Bun.file('src/lib/server/cleanup/runtime.ts').text()).not.toContain(
      "registerDrain('cleanup-worker'"
    );
  });

  test('settings and diagnostics pages use live contracts instead of milestone placeholders', async () => {
    const settings = await Bun.file('src/routes/settings/+page.svelte').text();
    const diagnostics = await Bun.file('src/routes/settings/diagnostics/+page.svelte').text();
    expect(settings).toContain('Environment configuration is authoritative');
    expect(settings).toContain('Save automatic policy and preview');
    expect(settings).toContain('Run current cleanup now');
    expect(settings).toContain('Remote Poyo cleanup');
    expect(diagnostics).toContain('Copy safe report');
    expect(diagnostics).toContain('Configured paths are deliberately redacted');
    expect(`${settings}\n${diagnostics}`).not.toContain('Not initialized in this milestone');
    expect(`${settings}\n${diagnostics}`).not.toContain('No audited registry loaded');
  });

  test('onboarding and settings keep paths and credential implementation choices behind the server', async () => {
    const welcome = await Bun.file('src/routes/welcome/+page.svelte').text();
    const settings = await Bun.file('src/routes/settings/+page.svelte').text();
    const mediaPrivacy = await Bun.file(
      'src/lib/components/settings/MediaPrivacyControls.svelte'
    ).text();
    for (const page of [welcome, settings]) {
      expect(page).toContain('never');
      expect(page).not.toContain('selectedBackend');
      expect(page).not.toContain('credential-backend');
      expect(page).not.toContain('storage-root');
      expect(page).not.toContain('output-location');
      expect(page).not.toMatch(/operating-system|keychain|macOS/i);
      expect(page).not.toMatch(/PLS_(?:APP_DATA_DIR|DATABASE_PATH|MEDIA_DIR|LOG_DIR)/);
    }
    expect(welcome).toContain('Your work stays local');
    expect(welcome).toContain('Protect local media metadata');
    expect(welcome).toContain('MediaPrivacyControls');
    expect(settings).toContain('Local-only data boundary');
    expect(settings).toContain('MediaPrivacyControls');
    expect(mediaPrivacy).toContain('Remote URLs');
    expect(mediaPrivacy).toContain('visible people, places, text, or audio');
    expect(settings).toContain('Clear local logs');
    expect(welcome).toContain('/api/settings/api-key');
    expect(settings).toContain('/api/settings/api-key');
    for (const deletedRoute of [
      'src/routes/api/settings/credential-backend/+server.ts',
      'src/routes/api/settings/credential-backend/conflict/+server.ts',
      'src/routes/api/settings/storage-root/+server.ts',
      'src/routes/api/settings/output-location/+server.ts'
    ]) {
      expect(await Bun.file(deletedRoute).exists()).toBe(false);
    }
  });

  test('optional media capabilities stay discoverable while Studio uploads and receipts remain compact', async () => {
    const welcomeLoad = await Bun.file('src/routes/welcome/+page.server.ts').text();
    const welcome = await Bun.file('src/routes/welcome/+page.svelte').text();
    const settingsLoad = await Bun.file('src/routes/settings/+page.server.ts').text();
    const studioLoad = await Bun.file('src/lib/server/generation/studio-data.ts').text();
    const mediaPrivacy = await Bun.file(
      'src/lib/components/settings/MediaPrivacyControls.svelte'
    ).text();
    const studio = await Bun.file('src/lib/components/studio/StudioWorkspace.svelte').text();
    const studioDraft = await Bun.file('src/lib/features/generation/studio-draft.ts').text();

    expect(welcomeLoad).toContain('platform.mediaTools.getReadiness()');
    expect(settingsLoad).toContain('platform.mediaTools.getReadiness()');
    expect(studioLoad).toContain('platform.mediaTools.getReadiness()');
    expect(studioLoad).toContain('readMediaPrivacySettings(platform.settings)');
    expect(mediaPrivacy).toContain('Media cleanup available');
    expect(mediaPrivacy).toContain('Media cleanup partially available');
    expect(mediaPrivacy).toContain('Optional media cleanup unavailable');
    expect(mediaPrivacy).toContain('Sanitize supported local media when available');
    expect(mediaPrivacy).toContain('disabled={disabled || !anyReady}');
    expect(mediaPrivacy).toContain('aria-describedby');
    expect(mediaPrivacy).toContain('Tool details');
    expect(welcome).toContain('Continue without media cleanup');
    expect(welcome).toContain('Media cleanup');
    expect(welcome).not.toContain('Your privacy, connection, appearance, and defaults are ready.');
    expect(studio).toContain('Optional tools unavailable — upload continues without cleanup');
    expect(studio).toContain('disabled={uploadingRole !== null || !hasApiKey}');
    expect(studio).not.toContain('data.sanitizeLocalMedia && !mediaKindReady(role.mediaKind)');
    expect(studio).toContain('Not cleaned · Cleanup off');
    expect(studio).toContain('Not cleaned · Optional tools unavailable');
    expect(studio).toMatch(/Cleaned · \$\{count\}/);
    expect(studio).toContain('Checked · No selected metadata found');
    expect(studio).not.toContain('Image orientation was not changed.');
    expect(studio).not.toContain('Some local uploads need setup');
    expect(studio).toContain('aria-live="polite"');
    expect(studio).toContain('role="alert"');
    expect(studioDraft).not.toContain('sanitizationReceipt');
  });
});
