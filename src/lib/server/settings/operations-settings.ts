import type { LocalCleanupPolicy } from '../../features/cleanup/contracts';
import type { SettingsDto } from '../../features/settings/contracts';
import { REMOTE_CLEANUP_CAPABILITY } from '../../features/cleanup/contracts';
import type { AppPaths } from '../platform/app-paths';
import type { StructuredLogger, LoggerRotationSettings } from '../diagnostics/jsonl-logger';
import { CleanupRepository } from '../cleanup/repository';
import { DEFAULT_CLEANUP_POLICY, normalizeCleanupPolicy } from '../cleanup/policy';
import type { ApiKeyStatusDto } from './api-key-manager';
import type { SettingsRepository } from './settings-repository';
import { readMediaPrivacySettings, saveMediaPrivacySettings } from './media-privacy-settings';

export interface OperationsSettings {
  polling: { intervalMs: number; staleAfterMs: number };
  downloads: { automatic: boolean };
  logs: LoggerRotationSettings;
  theme: { defaultMode: 'light' | 'dark' | 'system' };
}

export const DEFAULT_OPERATIONS_SETTINGS: OperationsSettings = {
  polling: { intervalMs: 10_000, staleAfterMs: 15 * 60_000 },
  downloads: { automatic: true },
  logs: {
    separateErrorFile: true,
    maxBytes: 5 * 1024 * 1024,
    maxAgeMs: 24 * 60 * 60 * 1000,
    retentionAgeMs: 14 * 24 * 60 * 60 * 1000,
    maxRotatedFiles: 10
  },
  theme: { defaultMode: 'light' }
};

function boundedInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${name} is outside the supported range.`);
  }
  return Number(value);
}

export function normalizeOperationsSettings(value: unknown): OperationsSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Settings must be an object.');
  }
  const input = value as Record<string, unknown>;
  const polling = (input.polling ?? {}) as Record<string, unknown>;
  const downloads = (input.downloads ?? {}) as Record<string, unknown>;
  const logs = (input.logs ?? {}) as Record<string, unknown>;
  const theme = (input.theme ?? {}) as Record<string, unknown>;
  const intervalMs = boundedInteger(polling.intervalMs, 'Polling interval', 1_000, 300_000);
  const staleAfterMs = boundedInteger(
    polling.staleAfterMs,
    'Stale threshold',
    intervalMs,
    7 * 24 * 60 * 60 * 1000
  );
  if (typeof downloads.automatic !== 'boolean') {
    throw new Error('Automatic download setting must be boolean.');
  }
  if (typeof logs.separateErrorFile !== 'boolean') {
    throw new Error('Separate error log setting must be boolean.');
  }
  const mode = theme.defaultMode;
  if (!['light', 'dark', 'system'].includes(String(mode))) {
    throw new Error('Theme mode is not supported.');
  }
  return {
    polling: { intervalMs, staleAfterMs },
    downloads: { automatic: downloads.automatic },
    logs: {
      separateErrorFile: logs.separateErrorFile,
      maxBytes: boundedInteger(logs.maxBytes, 'Log size', 64 * 1024, 1024 * 1024 * 1024),
      maxAgeMs: boundedInteger(logs.maxAgeMs, 'Log age', 60_000, 30 * 24 * 60 * 60 * 1000),
      retentionAgeMs: boundedInteger(
        logs.retentionAgeMs,
        'Log retention',
        60 * 60 * 1000,
        365 * 24 * 60 * 60 * 1000
      ),
      maxRotatedFiles: boundedInteger(logs.maxRotatedFiles, 'Log file count', 1, 100)
    },
    theme: { defaultMode: mode as OperationsSettings['theme']['defaultMode'] }
  };
}

export class OperationsSettingsService {
  private readonly cleanup: CleanupRepository;

  constructor(
    private readonly repository: SettingsRepository,
    database: ConstructorParameters<typeof CleanupRepository>[0],
    private readonly logger: StructuredLogger
  ) {
    this.cleanup = new CleanupRepository(database);
  }

  get(): OperationsSettings {
    return (
      this.repository.get<OperationsSettings>('operations')?.value ?? DEFAULT_OPERATIONS_SETTINGS
    );
  }

  update(input: { operations?: unknown; localCleanup?: unknown; mediaPrivacy?: unknown }): {
    operations: OperationsSettings;
    localCleanup: LocalCleanupPolicy;
    mediaPrivacy: SettingsDto['mediaPrivacy'];
  } {
    const operations =
      input.operations === undefined ? this.get() : normalizeOperationsSettings(input.operations);
    const localCleanup =
      input.localCleanup === undefined
        ? (this.cleanup.getPolicy() ?? this.cleanup.savePolicy(DEFAULT_CLEANUP_POLICY))
        : this.cleanup.savePolicy(normalizeCleanupPolicy(input.localCleanup));
    const mediaPrivacy =
      input.mediaPrivacy === undefined
        ? readMediaPrivacySettings(this.repository)
        : saveMediaPrivacySettings(this.repository, input.mediaPrivacy);
    this.repository.set('operations', operations);
    this.logger.updateRotationSettings(operations.logs);
    return { operations, localCleanup, mediaPrivacy };
  }

  dto(paths: AppPaths, apiKey: ApiKeyStatusDto): SettingsDto {
    const operations = this.get();
    const localCleanup = this.cleanup.getPolicy() ?? DEFAULT_CLEANUP_POLICY;
    return {
      apiKey,
      storage: {
        source: paths.source
      },
      ...operations,
      mediaPrivacy: readMediaPrivacySettings(this.repository),
      localCleanup,
      remoteCleanup: REMOTE_CLEANUP_CAPABILITY
    };
  }
}
