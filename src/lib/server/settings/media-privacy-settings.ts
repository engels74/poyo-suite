import type { MediaPrivacySettings } from '../../features/settings/contracts';
import {
  DEFAULT_MEDIA_PRIVACY_SETTINGS,
  normalizeMediaPrivacySettings,
  parseMediaPrivacySettings
} from '../../features/settings/media-privacy';
import type { SettingsRepository } from './settings-repository';

export const MEDIA_PRIVACY_SETTINGS_KEY = 'media-privacy';
export const MEDIA_PRIVACY_SETTINGS_VERSION = 1;

export function readMediaPrivacySettings(repository: SettingsRepository): MediaPrivacySettings {
  try {
    const stored = repository.get<unknown>(MEDIA_PRIVACY_SETTINGS_KEY);
    return normalizeMediaPrivacySettings(stored?.value);
  } catch {
    return { ...DEFAULT_MEDIA_PRIVACY_SETTINGS };
  }
}

export function saveMediaPrivacySettings(
  repository: SettingsRepository,
  value: unknown
): MediaPrivacySettings {
  const settings = parseMediaPrivacySettings(value);
  repository.set(MEDIA_PRIVACY_SETTINGS_KEY, settings, MEDIA_PRIVACY_SETTINGS_VERSION);
  return settings;
}
