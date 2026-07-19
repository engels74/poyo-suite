import type {
  CleanupConsequence,
  CleanupPolicyMode,
  LocalCleanupPolicy
} from '../cleanup/contracts';
import type { OperationsDiagnosticsDto } from '../diagnostics/contracts';
import type { ApiKeySettingsDto, MediaPrivacySettings, SettingsDto } from './contracts';
import { parseMediaPrivacySettings } from './media-privacy';

export interface SettingsDraft {
  pollingSeconds: number;
  staleMinutes: number;
  automaticDownloads: boolean;
  logSizeMb: number;
  logAgeHours: number;
  logRetentionDays: number;
  maxRotatedFiles: number;
  separateErrorFile: boolean;
  theme: SettingsDto['theme']['defaultMode'];
  cleanupMode: CleanupPolicyMode;
  olderThanDays: number;
  maxStorageGb: number;
  minFreeGb: number;
  excludeFavorites: boolean;
  excludePinned: boolean;
  excludedTags: string;
  mediaPrivacy: MediaPrivacySettings;
}

const mb = 1024 * 1024;
const gb = 1024 * mb;
const hour = 60 * 60 * 1000;
const day = 24 * hour;

export function settingsDraft(settings: SettingsDto): SettingsDraft {
  return {
    pollingSeconds: settings.polling.intervalMs / 1000,
    staleMinutes: settings.polling.staleAfterMs / 60_000,
    automaticDownloads: settings.downloads.automatic,
    logSizeMb: settings.logs.maxBytes / mb,
    logAgeHours: settings.logs.maxAgeMs / hour,
    logRetentionDays: settings.logs.retentionAgeMs / day,
    maxRotatedFiles: settings.logs.maxRotatedFiles,
    separateErrorFile: settings.logs.separateErrorFile,
    theme: settings.theme.defaultMode,
    cleanupMode: settings.localCleanup.mode,
    olderThanDays: settings.localCleanup.olderThanDays ?? 30,
    maxStorageGb: (settings.localCleanup.maxBytes ?? 50 * gb) / gb,
    minFreeGb: (settings.localCleanup.minFreeBytes ?? 10 * gb) / gb,
    excludeFavorites: settings.localCleanup.exclusions.favorites,
    excludePinned: settings.localCleanup.exclusions.pinned,
    excludedTags: settings.localCleanup.exclusions.tags.join(', '),
    mediaPrivacy: { ...settings.mediaPrivacy }
  };
}

export function mediaPrivacyRequest(draft: SettingsDraft): MediaPrivacySettings {
  return parseMediaPrivacySettings(draft.mediaPrivacy);
}

function integer(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be greater than zero.`);
  return Math.round(value);
}

export function operationsRequest(draft: SettingsDraft) {
  return {
    polling: {
      intervalMs: integer(draft.pollingSeconds * 1000, 'Polling interval'),
      staleAfterMs: integer(draft.staleMinutes * 60_000, 'Stale threshold')
    },
    downloads: { automatic: draft.automaticDownloads },
    logs: {
      separateErrorFile: draft.separateErrorFile,
      maxBytes: integer(draft.logSizeMb * mb, 'Log size'),
      maxAgeMs: integer(draft.logAgeHours * hour, 'Log age'),
      retentionAgeMs: integer(draft.logRetentionDays * day, 'Log retention'),
      maxRotatedFiles: integer(draft.maxRotatedFiles, 'Log file count')
    },
    theme: { defaultMode: draft.theme }
  };
}

export function cleanupPolicyRequest(
  draft: SettingsDraft,
  consequence: CleanupConsequence = 'file'
): LocalCleanupPolicy {
  const tags = [
    ...new Set(
      draft.excludedTags
        .split(',')
        .map((tag) => tag.trim().toLocaleLowerCase())
        .filter(Boolean)
    )
  ];
  return {
    mode: draft.cleanupMode,
    consequence,
    olderThanDays: draft.cleanupMode === 'age' ? integer(draft.olderThanDays, 'Age') : null,
    maxBytes:
      draft.cleanupMode === 'total-size' ? integer(draft.maxStorageGb * gb, 'Storage limit') : null,
    minFreeBytes:
      draft.cleanupMode === 'min-free-space'
        ? integer(draft.minFreeGb * gb, 'Free-space threshold')
        : null,
    exclusions: {
      favorites: draft.excludeFavorites,
      pinned: draft.excludePinned,
      tags
    }
  };
}

export function apiKeyUiState(status: ApiKeySettingsDto) {
  if (status.environmentManaged)
    return {
      label: 'Environment key active',
      detail: 'The server environment is authoritative. Browser configuration cannot replace it.',
      canConfigure: false,
      canRemove: false,
      canTest: status.status === 'configured'
    };
  if (status.source === 'local' && status.status === 'configured')
    return {
      label: 'Local key active',
      detail: 'Stored by the local server in its account-scoped secret store.',
      canConfigure: status.onboardingAvailable,
      canRemove: status.localMutationAvailable,
      canTest: true
    };
  return {
    label: status.status === 'unavailable' ? 'Secret store unavailable' : 'API key required',
    detail:
      status.status === 'unavailable'
        ? 'Local onboarding is unavailable. Configure POYO_API_KEY in the server environment.'
        : 'Add a key to the local server to enable Poyo requests.',
    canConfigure: status.onboardingAvailable && status.status !== 'unavailable',
    canRemove: false,
    canTest: false
  };
}

export function cleanupConsequenceLabel(consequence: CleanupConsequence): string {
  if (consequence === 'file')
    return 'Delete files and keep history metadata marked as locally unavailable.';
  if (consequence === 'metadata')
    return 'Delete database output records but leave untracked files on disk.';
  return 'Delete both local files and their output metadata.';
}

export function diagnosticsReport(diagnostics: OperationsDiagnosticsDto): string {
  const report = {
    application: diagnostics.health.application,
    health: diagnostics.health.status,
    checkedAt: diagnostics.health.checkedAt,
    network: diagnostics.health.network,
    database: diagnostics.health.database,
    apiKey: diagnostics.health.apiKey,
    connectivity: diagnostics.connectivity,
    registry: diagnostics.registry,
    storage: diagnostics.storage,
    cleanup: diagnostics.cleanup,
    remoteCleanup: diagnostics.remoteCleanup,
    logging: diagnostics.logging,
    settings: diagnostics.settings,
    redaction: 'Secrets and local filesystem paths are excluded.'
  };
  return `Poyo Local Studio diagnostics\n${JSON.stringify(report, null, 2)}`;
}
