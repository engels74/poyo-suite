import { describe, expect, test } from 'bun:test';
import { REMOTE_CLEANUP_CAPABILITY } from '../../../src/lib/features/cleanup/contracts';
import type { OperationsDiagnosticsDto } from '../../../src/lib/features/diagnostics/contracts';
import type { ApiKeySettingsDto, SettingsDto } from '../../../src/lib/features/settings/contracts';
import {
  apiKeyUiState,
  cleanupConsequenceLabel,
  cleanupPolicyRequest,
  credentialBackendUiState,
  diagnosticsReport,
  operationsRequest,
  settingsDraft,
  storageRootUiState
} from '../../../src/lib/features/settings/controller';

const localCleanup: SettingsDto['localCleanup'] = {
  mode: 'never',
  consequence: 'file',
  olderThanDays: null,
  maxBytes: null,
  minFreeBytes: null,
  exclusions: { favorites: true, pinned: true, tags: [] }
};

function key(overrides: Partial<ApiKeySettingsDto> = {}): ApiKeySettingsDto {
  return {
    source: 'none',
    status: 'missing',
    storeKind: 'file',
    selectedBackend: 'file',
    backendAvailability: { file: 'available', os: 'unchecked' },
    transition: null,
    onboardingAvailable: true,
    environmentManaged: false,
    localMutationAvailable: true,
    updatedAt: null,
    ...overrides
  };
}

function settings(apiKey = key()): SettingsDto {
  return {
    apiKey,
    storage: {
      source: 'project-default'
    },
    polling: { intervalMs: 5_000, staleAfterMs: 900_000 },
    downloads: { automatic: true },
    logs: {
      separateErrorFile: true,
      maxBytes: 5 * 1024 * 1024,
      maxAgeMs: 24 * 60 * 60 * 1000,
      retentionAgeMs: 14 * 24 * 60 * 60 * 1000,
      maxRotatedFiles: 10
    },
    theme: { defaultMode: 'light' },
    localCleanup,
    remoteCleanup: REMOTE_CLEANUP_CAPABILITY
  };
}

function diagnostics(): OperationsDiagnosticsDto {
  return {
    health: {
      status: 'ok',
      checkedAt: '2026-07-15T12:00:00.000Z',
      application: { version: '0.1.0', databaseSchemaVersion: 2, registrySchemaVersion: 1 },
      network: { defaultHost: '127.0.0.1', loopbackOnlyByDefault: true },
      database: { status: 'ok', foreignKeys: true, schemaVersion: 2 },
      apiKey: {
        source: 'environment',
        status: 'configured',
        storeKind: 'environment',
        onboardingAvailable: false,
        environmentManaged: true
      },
      logging: {
        status: 'ok',
        separateErrorFile: true,
        files: 2,
        bytes: 1024,
        lastRotationError: null,
        rotation: settings().logs
      }
    },
    connectivity: { checkedAt: '2026-07-15T12:00:00.000Z', status: 'ok' },
    storage: {
      indexedBytes: 2048,
      verifiedFiles: 1,
      missingOrDeletedFiles: 0,
      generatedBytes: 2048,
      managedSourceBytes: 0,
      managedSourceFiles: 0,
      missingOrDeletedSources: 0,
      capacityBytes: 4096,
      freeBytes: 2048
    },
    cleanup: {
      running: false,
      scheduled: false,
      lastRunAt: null,
      lastError: null,
      actions: {}
    },
    remoteCleanup: REMOTE_CLEANUP_CAPABILITY,
    registry: [{ version: '2026.07.15.1', verified_at: '2026-07-15', status: 'current' }],
    settings: {
      polling: settings().polling,
      downloads: settings().downloads,
      theme: settings().theme,
      logs: settings().logs,
      storageSource: 'project-default'
    },
    logging: {
      status: 'ok',
      separateErrorFile: true,
      files: 2,
      bytes: 1024,
      lastRotationError: null,
      rotation: settings().logs
    }
  };
}

describe('settings UI controller', () => {
  test('SET-01 makes an environment key authoritative and non-overridable', () => {
    const state = apiKeyUiState(
      key({
        source: 'environment',
        status: 'configured',
        storeKind: 'environment',
        onboardingAvailable: false,
        environmentManaged: true
      })
    );
    expect(state).toEqual({
      label: 'Environment key active',
      detail: 'The server environment is authoritative. Browser configuration cannot replace it.',
      canConfigure: false,
      canRemove: false,
      canTest: true
    });
  });

  test('supports local onboarding and removal without exposing credential material', () => {
    expect(apiKeyUiState(key())).toMatchObject({ canConfigure: true, canRemove: false });
    const state = apiKeyUiState(
      key({ source: 'local', status: 'configured', storeKind: 'os', updatedAt: '2026-07-15' })
    );
    expect(state).toMatchObject({ canConfigure: true, canRemove: true, canTest: true });
    expect(JSON.stringify(state)).not.toContain('sk-');
  });

  test('presents selected and effective credential authority without probing or exposing values', () => {
    expect(credentialBackendUiState(key())).toEqual({
      selected: 'Permission-protected file',
      effective: 'No active credential',
      transition: null,
      conflict: false,
      actions: []
    });
    expect(
      credentialBackendUiState(
        key({
          source: 'environment',
          status: 'configured',
          storeKind: 'environment',
          environmentManaged: true,
          selectedBackend: 'os'
        })
      )
    ).toMatchObject({
      selected: 'Operating-system credential store',
      effective: 'POYO_API_KEY environment variable'
    });
  });

  test('presents restart and retained-source root states honestly', () => {
    const project = { kind: 'project' as const, label: 'Project data folder', location: './data' };
    const platform = {
      kind: 'platform' as const,
      label: 'macOS Application Support',
      location: '~/Library/Application Support/Poyo Local Studio'
    };
    expect(
      storageRootUiState({
        current: project,
        selected: platform,
        effective: project,
        choices: [project, platform],
        state: 'restart-required',
        sourceRetention: 'retained-until-restart',
        cleanupPhase: 'source-retained',
        exclusions: [],
        environmentManaged: false,
        mutationAvailable: false,
        restartRequired: true
      })
    ).toEqual({
      detail:
        'macOS Application Support is selected. Project data folder remains effective until restart.',
      retention:
        'The root-owned source data is retained until restart verifies and activates the copied data.',
      exclusionSummary: ''
    });

    expect(
      storageRootUiState({
        current: project,
        selected: project,
        effective: project,
        choices: [project, platform],
        state: 'active',
        sourceRetention: 'none',
        cleanupPhase: 'none',
        exclusions: [
          {
            resource: 'current-output-directory',
            environmentManaged: false,
            count: 1,
            copied: false
          },
          {
            resource: 'historical-output-directories',
            environmentManaged: false,
            count: 2,
            copied: false
          }
        ],
        environmentManaged: false,
        mutationAvailable: true,
        restartRequired: false
      }).exclusionSummary
    ).toBe(
      'the current custom output directory, 2 historical output directories remain outside the selected root and are not copied.'
    );
  });

  test('normalizes operation and cleanup form values into durable server units', () => {
    const draft = settingsDraft(settings());
    draft.pollingSeconds = 8;
    draft.cleanupMode = 'total-size';
    draft.maxStorageGb = 2;
    draft.excludedTags = 'Archive, client-work, archive';
    expect(operationsRequest(draft).polling).toEqual({
      intervalMs: 8_000,
      staleAfterMs: 900_000
    });
    expect(cleanupPolicyRequest(draft, 'both')).toEqual({
      mode: 'total-size',
      consequence: 'both',
      olderThanDays: null,
      maxBytes: 2 * 1024 * 1024 * 1024,
      minFreeBytes: null,
      exclusions: { favorites: true, pinned: true, tags: ['archive', 'client-work'] }
    });
    expect(cleanupConsequenceLabel('file')).toContain('keep history metadata');
    expect(cleanupConsequenceLabel('metadata')).toContain('untracked files');
    expect(cleanupConsequenceLabel('both')).toContain('both local files');
  });

  test('DIAG-01 copies a whitelisted report without secret-like extras or paths', () => {
    const sentinel = 'sk-test_diagnostics_ui_canary_123456';
    const value = diagnostics() as OperationsDiagnosticsDto & {
      rawPath?: string;
      secret?: string;
    };
    value.rawPath = '/Users/example/private/studio.sqlite';
    value.secret = sentinel;
    const report = diagnosticsReport(value);
    expect(report).toContain('Poyo Local Studio diagnostics');
    expect(report).toContain('127.0.0.1');
    expect(report).toContain(REMOTE_CLEANUP_CAPABILITY.reason);
    expect(report).not.toContain(value.rawPath);
    expect(report).not.toContain(sentinel);
  });
});
