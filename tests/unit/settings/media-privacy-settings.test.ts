import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  DEFAULT_MEDIA_PRIVACY_SETTINGS,
  normalizeMediaPrivacySettings,
  parseMediaPrivacySettings
} from '../../../src/lib/features/settings/media-privacy';
import { openDatabase } from '../../../src/lib/server/platform/database';
import {
  MEDIA_PRIVACY_SETTINGS_KEY,
  MEDIA_PRIVACY_SETTINGS_VERSION,
  readMediaPrivacySettings,
  saveMediaPrivacySettings
} from '../../../src/lib/server/settings/media-privacy-settings';
import { SettingsRepository } from '../../../src/lib/server/settings/settings-repository';
import { createTemporaryDirectory } from '../../helpers/temporary-directory';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function repository(): Promise<{
  database: Awaited<ReturnType<typeof openDatabase>>;
  settings: SettingsRepository;
}> {
  const directory = await createTemporaryDirectory('media-privacy-settings-');
  const database = await openDatabase(join(directory.path, 'studio.sqlite'));
  cleanups.push(directory.cleanup, () => database.close());
  return { database, settings: new SettingsRepository(database) };
}

describe('media privacy settings', () => {
  test('uses protective defaults and normalizes partial or wrong-type fields independently', () => {
    expect(normalizeMediaPrivacySettings(null)).toEqual(DEFAULT_MEDIA_PRIVACY_SETTINGS);
    expect(
      normalizeMediaPrivacySettings({
        sanitizeLocalMedia: false,
        removeExif: 'false'
      })
    ).toEqual({
      ...DEFAULT_MEDIA_PRIVACY_SETTINGS,
      sanitizeLocalMedia: false
    });
  });

  test('strict parsing requires the complete known boolean object without coercion', () => {
    const complete = {
      ...DEFAULT_MEDIA_PRIVACY_SETTINGS,
      removeColorProfile: true
    };
    expect(parseMediaPrivacySettings(complete)).toEqual(complete);
    expect(() => parseMediaPrivacySettings({ ...complete, removeExif: 'true' })).toThrow(
      'must be boolean'
    );
    expect(() => parseMediaPrivacySettings({ ...complete, extra: false })).toThrow(
      'supported fields'
    );
    const partial: Record<string, unknown> = { ...complete };
    delete partial.removeXmp;
    expect(() => parseMediaPrivacySettings(partial)).toThrow('supported fields');
  });

  test('reads missing, partial, and corrupt records safely and persists version 1', async () => {
    const { settings } = await repository();
    expect(readMediaPrivacySettings(settings)).toEqual(DEFAULT_MEDIA_PRIVACY_SETTINGS);

    settings.set(MEDIA_PRIVACY_SETTINGS_KEY, { sanitizeLocalMedia: false, removeExif: null }, 7);
    expect(readMediaPrivacySettings(settings)).toEqual({
      ...DEFAULT_MEDIA_PRIVACY_SETTINGS,
      sanitizeLocalMedia: false
    });

    settings.set(MEDIA_PRIVACY_SETTINGS_KEY, 'corrupt', 7);
    expect(readMediaPrivacySettings(settings)).toEqual(DEFAULT_MEDIA_PRIVACY_SETTINGS);

    const saved = saveMediaPrivacySettings(settings, {
      ...DEFAULT_MEDIA_PRIVACY_SETTINGS,
      sanitizeLocalMedia: false,
      removeIptc: false
    });
    expect(saved.sanitizeLocalMedia).toBe(false);
    expect(saved.removeIptc).toBe(false);
    expect(settings.get(MEDIA_PRIVACY_SETTINGS_KEY)?.version).toBe(MEDIA_PRIVACY_SETTINGS_VERSION);
  });
});
