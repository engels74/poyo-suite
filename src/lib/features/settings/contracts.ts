export interface ApiKeySettingsDto {
  source: 'environment' | 'local' | 'none';
  status: 'configured' | 'missing' | 'unavailable' | 'error';
  storeKind: 'environment' | 'os' | 'file' | 'unavailable';
  selectedBackend: 'file' | 'os';
  backendAvailability: Record<'file' | 'os', 'available' | 'unavailable' | 'unchecked'>;
  transition: {
    sourceBackend: 'file' | 'os';
    targetBackend: 'file' | 'os';
    phase:
      | 'intent'
      | 'target-written'
      | 'target-verified'
      | 'target-authoritative-cleanup-source'
      | 'target-authoritative-source-retained'
      | 'rollback-cleanup-pending'
      | 'complete';
    conflict:
      | 'pre-authority-recovery-required'
      | 'pre-authority-ownership-unverified'
      | 'replacement-authorization-required'
      | 'rollback-cleanup-required'
      | 'rollback-ownership-unverified'
      | 'authoritative-cleanup-required'
      | 'authoritative-target-unavailable'
      | 'authoritative-source-retained'
      | 'backend-observation-unavailable'
      | null;
    actions: Array<
      | 'abandon'
      | 'resume-transition'
      | 'retry-cleanup'
      | 'acknowledge-retained-source'
      | 'reauthorize-replacement'
    >;
  } | null;
  onboardingAvailable: boolean;
  environmentManaged: boolean;
  localMutationAvailable: boolean;
  updatedAt: string | null;
}

export interface StorageSettingsDto {
  source: 'environment' | 'project-default' | 'platform-selected';
}

export type StorageRootKind = 'project' | 'platform' | 'environment';

export interface StorageRootChoiceDto {
  kind: StorageRootKind;
  label: string;
  location: string;
}

export interface StorageRootExclusionDto {
  resource:
    | 'database'
    | 'media'
    | 'logs'
    | 'current-output-directory'
    | 'historical-output-directories';
  environmentManaged: boolean;
  count: number;
  copied: false;
}

export type StorageRootCleanupPhase =
  | 'none'
  | 'source-retained'
  | 'source-deletion-in-progress'
  | 'source-removed'
  | 'target-finalization-pending'
  | 'complete';

export interface StorageRootSettingsDto {
  current: StorageRootChoiceDto;
  selected: StorageRootChoiceDto;
  effective: StorageRootChoiceDto;
  choices: [StorageRootChoiceDto, StorageRootChoiceDto];
  state:
    | 'active'
    | 'transitioning'
    | 'restart-required'
    | 'cleanup-pending'
    | 'environment-managed';
  sourceRetention:
    | 'none'
    | 'retained-until-restart'
    | 'removed'
    | 'retained-cleanup-pending'
    | 'residue-cleanup-pending';
  cleanupPhase: StorageRootCleanupPhase;
  exclusions: StorageRootExclusionDto[];
  environmentManaged: boolean;
  mutationAvailable: boolean;
  restartRequired: boolean;
}

export interface OutputLocationDto {
  /** A custom output directory is persisted in local settings. */
  configured: boolean;
  /** PLS_MEDIA_DIR from the environment takes precedence and cannot be overridden here. */
  environmentManaged: boolean;
  /** The directory generated media is written to right now. */
  active: string;
  /** A saved directory that will take effect on the next restart (null when already active). */
  pending: string | null;
  requiresRestart: boolean;
}

export interface OnboardingStepsDto {
  location: boolean;
  // Named "connection" rather than "apiKey" so the persisted settings blob never contains a
  // key matching the secret-key guard in SettingsRepository.
  connection: boolean;
  theme: boolean;
  defaults: boolean;
}

export interface OnboardingStateDto {
  completed: boolean;
  completedAt: string | null;
  dismissedAt: string | null;
  version: number;
  steps: OnboardingStepsDto;
  /** Completion was inferred for an existing install rather than explicitly recorded. */
  inferred: boolean;
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
  localCleanup: import('../cleanup/contracts').LocalCleanupPolicy;
  remoteCleanup: import('../cleanup/contracts').RemoteCleanupCapabilityDto;
}
