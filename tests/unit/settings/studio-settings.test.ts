import { afterEach, describe, expect, test } from 'bun:test';
import type { AppPaths } from '../../../src/lib/server/platform/app-paths';
import { openDatabase } from '../../../src/lib/server/platform/database';
import { SettingsRepository } from '../../../src/lib/server/settings/settings-repository';
import {
  computeOnboardingState,
  outputLocationDto,
  readOnboarding,
  readStoragePreferences,
  resolveEffectiveMedia,
  saveOutputDirectory,
  updateOnboarding
} from '../../../src/lib/server/settings/studio-settings';
import { createTemporaryDirectory } from '../../helpers/temporary-directory';
import { join } from 'node:path';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function repository(): Promise<SettingsRepository> {
  const dir = await createTemporaryDirectory('studio-settings');
  const database = await openDatabase(join(dir.path, 'studio.sqlite'));
  cleanups.push(() => dir.cleanup());
  cleanups.push(() => database.close());
  return new SettingsRepository(database);
}

function paths(media: string): AppPaths {
  return {
    root: '/root',
    database: '/root/data/db.sqlite',
    media,
    uploads: '/root/uploads',
    thumbnails: '/root/thumbnails',
    logs: '/root/logs',
    secrets: '/root/secrets',
    temporary: '/root/tmp',
    source: 'platform-default'
  };
}

describe('storage preferences', () => {
  test('defaults to no custom directory', async () => {
    const settings = await repository();
    expect(readStoragePreferences(settings)).toEqual({ outputDirectory: null, previousRoots: [] });
  });

  test('saving a directory retains the previous active root for read access', async () => {
    const settings = await repository();
    saveOutputDirectory(settings, '/volumes/work/media', '/root/media');
    const stored = readStoragePreferences(settings);
    expect(stored.outputDirectory).toBe('/volumes/work/media');
    expect(stored.previousRoots).toContain('/root/media');
  });

  test('changing the directory again keeps every historical root and drops the new one from history', async () => {
    const settings = await repository();
    saveOutputDirectory(settings, '/a', '/root/media');
    saveOutputDirectory(settings, '/b', '/a');
    const stored = readStoragePreferences(settings);
    expect(stored.outputDirectory).toBe('/b');
    expect(stored.previousRoots).toContain('/root/media');
    expect(stored.previousRoots).toContain('/a');
    expect(stored.previousRoots).not.toContain('/b');
  });

  test('clearing reverts future output to default but keeps prior roots readable', async () => {
    const settings = await repository();
    saveOutputDirectory(settings, '/a', '/root/media');
    saveOutputDirectory(settings, null, '/a');
    const stored = readStoragePreferences(settings);
    expect(stored.outputDirectory).toBeNull();
    expect(stored.previousRoots).toContain('/a');
  });

  test('trims whitespace-polluted persisted roots so later path matching stays reliable', async () => {
    const settings = await repository();
    settings.set('storage', {
      outputDirectory: '  /vol/media  ',
      previousRoots: ['  /old  ', '/old']
    });
    const stored = readStoragePreferences(settings);
    expect(stored.outputDirectory).toBe('/vol/media');
    expect(stored.previousRoots).toEqual(['/old']);
  });

  test('fails closed on corrupt paths: rejects non-absolute and normalizes the rest', async () => {
    const settings = await repository();
    settings.set('storage', {
      outputDirectory: 'relative/media',
      previousRoots: ['/abs/ok', 'also/relative', '../escape', '/nested/../ok']
    });
    const stored = readStoragePreferences(settings);
    expect(stored.outputDirectory).toBeNull();
    // Absolute roots survive and are normalized (`..` collapsed); relative ones are dropped.
    expect(stored.previousRoots).toEqual(['/abs/ok', '/ok']);
  });
});

describe('resolveEffectiveMedia', () => {
  test('uses the custom directory when set and env is not managing media', () => {
    const effective = resolveEffectiveMedia(
      paths('/root/media'),
      { outputDirectory: '/custom', previousRoots: ['/old'] },
      false
    );
    expect(effective.media).toBe('/custom');
    expect(effective.mediaReadRoots).toEqual(['/custom', '/root/media', '/old']);
    expect(effective.environmentManaged).toBe(false);
  });

  test('environment media wins but the configured custom and historical roots stay readable', () => {
    const effective = resolveEffectiveMedia(
      paths('/env/media'),
      { outputDirectory: '/custom', previousRoots: ['/old'] },
      true
    );
    expect(effective.media).toBe('/env/media');
    // The custom directory may already hold media downloaded before PLS_MEDIA_DIR was set, so it
    // must remain readable alongside the historical roots even though the env dir owns writes.
    expect(effective.mediaReadRoots).toEqual(['/env/media', '/custom', '/old']);
    expect(effective.environmentManaged).toBe(true);
  });

  test('keeps the platform default readable when PLS_MEDIA_DIR overrides an existing install', () => {
    // An install that wrote to <root>/media before PLS_MEDIA_DIR was added: the env dir owns writes
    // now, but the previous default root must stay in mediaReadRoots so older outputs remain servable.
    const effective = resolveEffectiveMedia(
      { ...paths('/env/media'), defaultMedia: '/root/media' },
      { outputDirectory: null, previousRoots: [] },
      true
    );
    expect(effective.media).toBe('/env/media');
    expect(effective.mediaReadRoots).toEqual(['/env/media', '/root/media']);
    expect(effective.environmentManaged).toBe(true);
  });

  test('falls back to the default media directory when nothing is configured', () => {
    const effective = resolveEffectiveMedia(
      paths('/root/media'),
      { outputDirectory: null, previousRoots: [] },
      false
    );
    expect(effective.media).toBe('/root/media');
    expect(effective.mediaReadRoots).toEqual(['/root/media']);
  });
});

describe('outputLocationDto', () => {
  test('flags a pending directory that will apply after restart', () => {
    // Active media is still the default; the stored directory differs -> restart required.
    const dto = outputLocationDto(
      paths('/root/media'),
      { outputDirectory: '/custom', previousRoots: [] },
      false
    );
    expect(dto).toEqual({
      configured: true,
      environmentManaged: false,
      active: '/root/media',
      pending: '/custom',
      requiresRestart: true
    });
  });

  test('no pending change once the directory is active', () => {
    const dto = outputLocationDto(
      paths('/custom'),
      { outputDirectory: '/custom', previousRoots: [] },
      false
    );
    expect(dto.pending).toBeNull();
    expect(dto.requiresRestart).toBe(false);
  });

  test('reports a pending revert to the default when a custom directory is cleared', () => {
    // A custom dir is still active this session, but the preference was reset -> the next restart
    // reverts to the default, so the DTO must surface the pending change rather than look immediate.
    const dto = outputLocationDto(
      { ...paths('/custom'), defaultMedia: '/root/media' },
      { outputDirectory: null, previousRoots: ['/custom'] },
      false
    );
    expect(dto).toEqual({
      configured: false,
      environmentManaged: false,
      active: '/custom',
      pending: '/root/media',
      requiresRestart: true
    });
  });

  test('environment managed reports no local configuration', () => {
    const dto = outputLocationDto(
      paths('/env/media'),
      { outputDirectory: null, previousRoots: [] },
      true
    );
    expect(dto.environmentManaged).toBe(true);
    expect(dto.configured).toBe(false);
  });
});

describe('onboarding state', () => {
  test('a brand-new install with no key or history is incomplete', () => {
    const state = computeOnboardingState(null, { apiKeyConfigured: false, hasHistory: false });
    expect(state.completed).toBe(false);
    expect(state.inferred).toBe(false);
  });

  test('an existing install with a configured key is inferred complete', () => {
    const state = computeOnboardingState(null, { apiKeyConfigured: true, hasHistory: false });
    expect(state.completed).toBe(true);
    expect(state.inferred).toBe(true);
  });

  test('an existing install with prior jobs/media is inferred complete', () => {
    const state = computeOnboardingState(null, { apiKeyConfigured: false, hasHistory: true });
    expect(state.completed).toBe(true);
    expect(state.inferred).toBe(true);
  });

  test('an explicit completion marker is not treated as inferred', () => {
    const state = computeOnboardingState(
      {
        version: 1,
        completedAt: '2026-01-01T00:00:00.000Z',
        dismissedAt: null,
        steps: { location: true, connection: true, theme: true, defaults: true }
      },
      { apiKeyConfigured: false, hasHistory: false }
    );
    expect(state.completed).toBe(true);
    expect(state.inferred).toBe(false);
  });

  test('update records completion and reopen clears it', async () => {
    const settings = await repository();
    const completed = updateOnboarding(settings, { complete: true, steps: { location: true } });
    expect(completed.completedAt).not.toBeNull();
    expect(completed.steps.location).toBe(true);
    expect(readOnboarding(settings)?.completedAt).not.toBeNull();

    const reopened = updateOnboarding(settings, { reopen: true });
    expect(reopened.completedAt).toBeNull();
    expect(reopened.dismissedAt).toBeNull();
    // Reopening restarts the flow: previously-completed steps reset so firstIncompleteStep() lands
    // on the first step rather than the done screen.
    expect(reopened.steps).toEqual({
      location: false,
      connection: false,
      theme: false,
      defaults: false
    });
  });

  test('dismiss marks completion without a completedAt', async () => {
    const settings = await repository();
    const dismissed = updateOnboarding(settings, { dismiss: true });
    expect(dismissed.dismissedAt).not.toBeNull();
    const state = computeOnboardingState(readOnboarding(settings), {
      apiKeyConfigured: false,
      hasHistory: false
    });
    expect(state.completed).toBe(true);
  });
});
