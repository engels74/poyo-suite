import type { Database } from 'bun:sqlite';
import type {
  StorageRootCleanupPhase,
  StorageRootChoiceDto,
  StorageRootSettingsDto
} from '../../features/settings/contracts';
import type { AppPaths, AppRootKind } from './app-paths';
import type { MaintenanceGate } from './maintenance-gate';
import { readRootMarker } from './root-selector';
import { persistedOutputResourceExclusions, relocationResourceExclusions } from './root-topology';

export interface StorageRootRuntimeStatus {
  cleanupPhase: StorageRootCleanupPhase;
}

function choice(
  kind: AppRootKind | 'environment',
  platform: NodeJS.Platform
): StorageRootChoiceDto {
  if (kind === 'project') {
    return { kind, label: 'Project data folder', location: './data' };
  }
  if (kind === 'environment') {
    return { kind, label: 'Environment-managed data folder', location: 'PLS_APP_DATA_DIR' };
  }
  if (platform === 'darwin') {
    return {
      kind,
      label: 'macOS Application Support',
      location: '~/Library/Application Support/Poyo Local Studio'
    };
  }
  if (platform === 'win32') {
    return {
      kind,
      label: 'Windows local application data',
      location: '%LOCALAPPDATA%\\Poyo Local Studio'
    };
  }
  return {
    kind,
    label: 'User application data',
    location: '$XDG_DATA_HOME/poyo-local-studio'
  };
}

export async function storageRootStatusDto(options: {
  paths: AppPaths;
  runtime: StorageRootRuntimeStatus;
  gate: Pick<MaintenanceGate, 'status'>;
  database?: Database;
  candidateRoots?: readonly string[];
  environment?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}): Promise<StorageRootSettingsDto> {
  const platform = options.platform ?? process.platform;
  const exclusions = [
    ...relocationResourceExclusions(options.environment ?? {}),
    ...(options.database
      ? await persistedOutputResourceExclusions({
          database: options.database,
          roots: options.candidateRoots ?? [options.paths.root],
          platform
        })
      : [])
  ];
  const choices: StorageRootSettingsDto['choices'] = [
    choice('project', platform),
    choice('platform', platform)
  ];
  const current = choice(options.paths.rootKind, platform);
  if (options.paths.rootKind === 'environment') {
    return {
      current,
      selected: current,
      effective: current,
      choices,
      state: 'environment-managed',
      sourceRetention: 'none',
      cleanupPhase: 'none',
      exclusions,
      environmentManaged: true,
      mutationAvailable: false,
      restartRequired: false
    };
  }

  const gate = options.gate.status();
  const marker = await readRootMarker(options.paths.root);
  const pendingKind =
    marker.status === 'valid' &&
    marker.marker.state === 'active-intent' &&
    marker.marker.peerRootKind
      ? marker.marker.peerRootKind
      : null;
  const restartRequired = gate.admission === 'frozen';
  const cleanupPending = !['none', 'complete'].includes(options.runtime.cleanupPhase);
  const state: StorageRootSettingsDto['state'] = restartRequired
    ? 'restart-required'
    : gate.admission === 'closed'
      ? 'transitioning'
      : cleanupPending
        ? 'cleanup-pending'
        : 'active';
  const selected = choice(pendingKind ?? options.paths.rootKind, platform);
  const sourceRetention: StorageRootSettingsDto['sourceRetention'] = pendingKind
    ? 'retained-until-restart'
    : options.runtime.cleanupPhase === 'source-retained'
      ? 'retained-cleanup-pending'
      : options.runtime.cleanupPhase === 'source-deletion-in-progress'
        ? 'residue-cleanup-pending'
        : options.runtime.cleanupPhase === 'source-removed' ||
            options.runtime.cleanupPhase === 'target-finalization-pending' ||
            options.runtime.cleanupPhase === 'complete'
          ? 'removed'
          : 'none';
  return {
    current,
    selected,
    effective: current,
    choices,
    state,
    sourceRetention,
    cleanupPhase: options.runtime.cleanupPhase,
    exclusions,
    environmentManaged: false,
    mutationAvailable: state === 'active',
    restartRequired
  };
}

export async function pendingStorageRootStatusDto(options: {
  currentRootKind: AppRootKind;
  targetRootKind: AppRootKind;
  database?: Database;
  candidateRoots?: readonly string[];
  environment?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}): Promise<StorageRootSettingsDto> {
  const platform = options.platform ?? process.platform;
  const current = choice(options.currentRootKind, platform);
  const selected = choice(options.targetRootKind, platform);
  const exclusions = [
    ...relocationResourceExclusions(options.environment ?? {}),
    ...(options.database
      ? await persistedOutputResourceExclusions({
          database: options.database,
          roots: options.candidateRoots ?? [],
          platform
        })
      : [])
  ];
  return {
    current,
    selected,
    effective: current,
    choices: [choice('project', platform), choice('platform', platform)],
    state: 'restart-required',
    sourceRetention: 'retained-until-restart',
    cleanupPhase: 'source-retained',
    exclusions,
    environmentManaged: false,
    mutationAvailable: false,
    restartRequired: true
  };
}
