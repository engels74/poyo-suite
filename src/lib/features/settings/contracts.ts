export interface ApiKeySettingsDto {
  source: 'environment' | 'local' | 'none';
  status: 'configured' | 'missing' | 'unavailable' | 'error';
  storeKind: 'environment' | 'file' | 'unavailable';
  onboardingAvailable: boolean;
  environmentManaged: boolean;
  localMutationAvailable: boolean;
  updatedAt: string | null;
}

export interface StorageSettingsDto {
  source: 'environment' | 'project-default';
}

export interface OnboardingStepsDto {
  location: boolean;
  mediaPrivacy: boolean;
  // Named "connection" rather than "apiKey" so the persisted settings blob never contains a
  // key matching the secret-key guard in SettingsRepository.
  connection: boolean;
  theme: boolean;
  defaults: boolean;
}

export interface MediaPrivacySettings {
  sanitizeLocalMedia: boolean;
  removeExif: boolean;
  removeIptc: boolean;
  removeXmp: boolean;
  removePhotoshop8bim: boolean;
  removeColorProfile: boolean;
}

export interface OnboardingStateDto {
  completed: boolean;
  completedAt: string | null;
  dismissedAt: string | null;
  version: number;
  steps: OnboardingStepsDto;
}

export interface SettingsDto {
  apiKey: ApiKeySettingsDto;
  storage: StorageSettingsDto;
  polling: { intervalMs: number; staleAfterMs: number };
  downloads: { automatic: boolean };
  logs: {
    separateErrorFile: boolean;
    maxBytes: number;
    maxAgeMs: number;
    retentionAgeMs: number;
    maxRotatedFiles: number;
  };
  theme: { defaultMode: 'light' | 'dark' | 'system' };
  mediaPrivacy: MediaPrivacySettings;
  localCleanup: import('../cleanup/contracts').LocalCleanupPolicy;
  remoteCleanup: import('../cleanup/contracts').RemoteCleanupCapabilityDto;
}
