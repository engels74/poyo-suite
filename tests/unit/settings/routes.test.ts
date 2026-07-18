import { describe, expect, test } from 'bun:test';

describe('settings HTTP and page boundaries', () => {
  test('SEC-04 every settings and cleanup mutation uses same-origin bounded JSON', async () => {
    for (const route of [
      'src/routes/api/settings/+server.ts',
      'src/routes/api/settings/api-key/+server.ts',
      'src/routes/api/settings/api-key/connectivity/+server.ts',
      'src/routes/api/settings/credential-backend/+server.ts',
      'src/routes/api/settings/credential-backend/conflict/+server.ts',
      'src/routes/api/settings/storage-root/+server.ts',
      'src/routes/api/onboarding/+server.ts',
      'src/routes/api/cleanup/preview/+server.ts',
      'src/routes/api/cleanup/apply/+server.ts'
    ]) {
      expect(await Bun.file(route).text()).toContain('readSameOriginJson');
    }
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

  test('onboarding and settings expose explicit root and credential choices with override states', async () => {
    const welcome = await Bun.file('src/routes/welcome/+page.svelte').text();
    const settings = await Bun.file('src/routes/settings/+page.svelte').text();
    const rootRoute = await Bun.file('src/routes/api/settings/storage-root/+server.ts').text();
    for (const page of [welcome, settings]) {
      expect(page).toContain('Permission-protected file (default)');
      expect(page).toContain('Operating-system store');
      expect(page).toContain('POYO_API_KEY');
      expect(page).toContain('PLS_APP_DATA_DIR');
    }
    expect(welcome).toContain('project data folder');
    expect(welcome).toContain('Move data and require restart');
    expect(settings).toContain('Move all Studio data');
    expect(settings).toContain('Move all root-owned Studio data');
    expect(settings).toContain('previous copy is retained pending cleanup');
    expect(welcome).toContain('previous copy is retained pending cleanup');
    expect(welcome).toContain('rootState.exclusionSummary');
    expect(settings).toContain('rootState.exclusionSummary');
    expect(settings).toContain('rootState.retention');
    expect(rootRoute).toContain('export const GET');
    expect(rootRoute).toContain("'cache-control': 'no-store'");
    expect(rootRoute).not.toContain('relocation: result');
    const credentialRoute = await Bun.file(
      'src/routes/api/settings/credential-backend/+server.ts'
    ).text();
    expect(credentialRoute).toContain('status: apiKey.transition ? 202 : 200');
  });
});
