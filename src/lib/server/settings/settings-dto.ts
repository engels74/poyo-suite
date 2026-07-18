import type { SettingsDto } from '../../features/settings/contracts';
import type { AppPaths } from '../platform/app-paths';
import type { ApiKeyStatusDto } from './api-key-manager';
import { REMOTE_CLEANUP_CAPABILITY } from '../../features/cleanup/contracts';
import { DEFAULT_CLEANUP_POLICY } from '../cleanup/policy';
import { DEFAULT_OPERATIONS_SETTINGS } from './operations-settings';

export function buildSettingsDto(paths: AppPaths, apiKey: ApiKeyStatusDto): SettingsDto {
  return {
    apiKey,
    storage: {
      source: paths.source
    },
    ...DEFAULT_OPERATIONS_SETTINGS,
    localCleanup: DEFAULT_CLEANUP_POLICY,
    remoteCleanup: REMOTE_CLEANUP_CAPABILITY
  };
}
