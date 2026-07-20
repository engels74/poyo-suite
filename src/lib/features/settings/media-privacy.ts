import type { MediaPrivacySettings, MediaToolsReadinessDto } from './contracts';

export type MediaSanitizationCapabilityState = 'available' | 'partial' | 'unavailable';

export function mediaKindSanitizationReady(
  readiness: MediaToolsReadinessDto,
  mediaKind: 'image' | 'video'
): boolean {
  return mediaKind === 'image' ? readiness.imageReady : readiness.videoReady;
}

export function mediaSanitizationCapabilityState(
  readiness: MediaToolsReadinessDto
): MediaSanitizationCapabilityState {
  if (readiness.imageReady && readiness.videoReady) return 'available';
  if (readiness.imageReady || readiness.videoReady) return 'partial';
  return 'unavailable';
}

export const DEFAULT_MEDIA_PRIVACY_SETTINGS: Readonly<MediaPrivacySettings> = Object.freeze({
  sanitizeLocalMedia: true,
  removeExif: true,
  removeIptc: true,
  removeXmp: true,
  removePhotoshop8bim: true,
  removeColorProfile: false
});

const fields = Object.keys(DEFAULT_MEDIA_PRIVACY_SETTINGS) as Array<keyof MediaPrivacySettings>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function normalizeMediaPrivacySettings(value: unknown): MediaPrivacySettings {
  const input = record(value);
  return {
    sanitizeLocalMedia:
      typeof input.sanitizeLocalMedia === 'boolean'
        ? input.sanitizeLocalMedia
        : DEFAULT_MEDIA_PRIVACY_SETTINGS.sanitizeLocalMedia,
    removeExif:
      typeof input.removeExif === 'boolean'
        ? input.removeExif
        : DEFAULT_MEDIA_PRIVACY_SETTINGS.removeExif,
    removeIptc:
      typeof input.removeIptc === 'boolean'
        ? input.removeIptc
        : DEFAULT_MEDIA_PRIVACY_SETTINGS.removeIptc,
    removeXmp:
      typeof input.removeXmp === 'boolean'
        ? input.removeXmp
        : DEFAULT_MEDIA_PRIVACY_SETTINGS.removeXmp,
    removePhotoshop8bim:
      typeof input.removePhotoshop8bim === 'boolean'
        ? input.removePhotoshop8bim
        : DEFAULT_MEDIA_PRIVACY_SETTINGS.removePhotoshop8bim,
    removeColorProfile:
      typeof input.removeColorProfile === 'boolean'
        ? input.removeColorProfile
        : DEFAULT_MEDIA_PRIVACY_SETTINGS.removeColorProfile
  };
}

export function parseMediaPrivacySettings(value: unknown): MediaPrivacySettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Media privacy settings must be an object.');
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key as never))) {
    throw new Error('Media privacy settings must contain only the supported fields.');
  }
  for (const field of fields) {
    if (typeof input[field] !== 'boolean') {
      throw new Error('Every media privacy setting must be boolean.');
    }
  }
  return input as unknown as MediaPrivacySettings;
}
