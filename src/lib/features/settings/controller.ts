import type {
  CleanupConsequence,
  CleanupPolicyMode,
  LocalCleanupPolicy
} from '../cleanup/contracts';
import type { OperationsDiagnosticsDto } from '../diagnostics/contracts';
import type {
  ApiKeySettingsDto,
  SettingsDto,
  StorageRootExclusionDto,
  StorageRootSettingsDto
} from './contracts';

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
    excludedTags: settings.localCleanup.exclusions.tags.join(', ')
  };
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
      detail: `Stored by the local server using the ${status.storeKind === 'os' ? 'operating-system credential store' : 'permission-restricted secret store'}.`,
      canConfigure: status.onboardingAvailable,
      canRemove: status.localMutationAvailable,
      canTest: true
    };
  return {
    label: status.status === 'unavailable' ? 'Secret store unavailable' : 'API key required',
    detail:
      status.status === 'unavailable'
        ? 'Local onboarding is unavailable. Configure POYO_API_KEY in the server environment.'
        : 'Environment configuration is preferred. A local server-side key can be added when supported.',
    canConfigure: status.onboardingAvailable && status.status !== 'unavailable',
    canRemove: false,
    canTest: false
  };
}

export function credentialBackendLabel(backend: 'file' | 'os'): string {
  return backend === 'file' ? 'Permission-protected file' : 'Operating-system credential store';
}

export function credentialBackendUiState(status: ApiKeySettingsDto) {
  const selected = credentialBackendLabel(status.selectedBackend);
  const effective = status.environmentManaged
    ? 'POYO_API_KEY environment variable'
    : status.status === 'configured'
      ? selected
      : 'No active credential';
  const source = status.transition ? credentialBackendLabel(status.transition.sourceBackend) : null;
  const target = status.transition ? credentialBackendLabel(status.transition.targetBackend) : null;
  const transition = status.transition
    ? status.transition.conflict === 'replacement-authorization-required'
      ? `The attempted move from ${source} to ${target} is paused because the destination changed. Both copies were retained, and the current backend remains authoritative.`
      : status.transition.conflict === 'pre-authority-ownership-unverified'
        ? `The attempted move from ${source} to ${target} cannot be resumed safely because source authority could not be verified. Stored copies were left unchanged.`
        : status.transition.conflict === 'pre-authority-recovery-required'
          ? `The attempted move from ${source} to ${target} is paused until you explicitly resume or abandon it. Stored copies were left unchanged during startup.`
          : status.transition.conflict === 'rollback-ownership-unverified'
            ? `Rollback cleanup from ${target} cannot be verified safely. The current ${source} authority and every retained copy were left unchanged.`
            : status.transition.conflict === 'rollback-cleanup-required'
              ? `Rollback cleanup from ${target} is ready for an explicit retry or can be abandoned without changing stored copies.`
              : status.transition.conflict === 'authoritative-target-unavailable'
                ? `${target} remains the selected authority but is unavailable. The previous ${source} copy is retained, and cleanup requires an explicit decision.`
                : status.transition.conflict === 'authoritative-source-retained'
                  ? `${target} remains authoritative. A previous ${source} copy is retained and will not be deleted without a verified cleanup retry.`
                  : status.transition.conflict === 'authoritative-cleanup-required'
                    ? `${target} is authoritative and the previous ${source} copy is retained until you explicitly retry verified cleanup.`
                    : status.transition.conflict === 'backend-observation-unavailable'
                      ? `Credential recovery is paused because a backend could not be observed safely. Authority was not changed and stored copies were not modified.`
                      : `Moving from ${source} to ${target} (${status.transition.phase.replaceAll('-', ' ')}).`
    : null;
  return {
    selected,
    effective,
    transition,
    conflict: Boolean(status.transition?.conflict),
    actions: status.transition?.actions ?? []
  };
}

export function storageRootExclusionSummary(exclusions: StorageRootExclusionDto[]): string {
  const labels = exclusions.map((item) => {
    if (item.resource === 'current-output-directory') return 'the current custom output directory';
    if (item.resource === 'historical-output-directories') {
      return `${item.count} historical output ${item.count === 1 ? 'directory' : 'directories'}`;
    }
    return `the environment-managed ${item.resource}`;
  });
  if (labels.length === 0) return '';
  return `${labels.join(', ')} remain outside the selected root and are not copied.`;
}

export function storageRootUiState(status: StorageRootSettingsDto) {
  const exclusionSummary = storageRootExclusionSummary(status.exclusions);
  const exclusions = exclusionSummary ? ` ${exclusionSummary}` : '';
  if (status.environmentManaged) {
    return {
      detail: `PLS_APP_DATA_DIR is authoritative. Restart without that override to use an in-app choice.${exclusions}`,
      retention: 'No in-app storage move is available.',
      exclusionSummary
    };
  }
  if (status.state === 'restart-required') {
    const rootMovePending = status.selected.kind !== status.current.kind;
    return {
      detail: rootMovePending
        ? `${status.selected.label} is selected. ${status.effective.label} remains effective until restart.${exclusions}`
        : `Local mutation is frozen until restart.${exclusions}`,
      retention: rootMovePending
        ? 'The root-owned source data is retained until restart verifies and activates the copied data.'
        : 'No new local changes are accepted in this process.',
      exclusionSummary
    };
  }
  if (status.state === 'cleanup-pending') {
    return {
      detail: `${status.effective.label} is active.${exclusions}`,
      retention:
        status.cleanupPhase === 'source-deletion-in-progress'
          ? 'Verified source residue remains and cleanup will retry on restart.'
          : status.cleanupPhase === 'source-removed' ||
              status.cleanupPhase === 'target-finalization-pending'
            ? 'The source was removed; target control finalization will retry on restart.'
            : 'The verified source copy is retained because cleanup did not finish; no data was discarded.',
      exclusionSummary
    };
  }
  if (status.state === 'transitioning') {
    return {
      detail: `Root-owned local data is being copied and verified. Writes are temporarily paused.${exclusions}`,
      retention: 'The source remains authoritative until publication succeeds.',
      exclusionSummary
    };
  }
  return {
    detail: `${status.effective.label} is active.${exclusions}`,
    retention:
      status.sourceRetention === 'removed'
        ? 'The previous source was removed after successful verification.'
        : 'No storage move is pending.',
    exclusionSummary
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
