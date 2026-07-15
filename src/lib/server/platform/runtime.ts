import { env } from '$env/dynamic/private';
import { DATABASE_SCHEMA_VERSION } from './version';
import { resolveAppPaths, ensureAppPaths } from './app-paths';
import { openDatabase } from './database';
import { StructuredLogger } from '../diagnostics/jsonl-logger';
import { ApiKeyManager } from '../settings/api-key-manager';
import { SecretMetadataRepository } from '../settings/secret-metadata-repository';
import { createPreferredSecretStore } from '../settings/secret-store';
import { SettingsRepository } from '../settings/settings-repository';
import { seedImageRegistry, seedVideoRegistry } from '../registry/repository';

export interface PlatformServices {
  paths: ReturnType<typeof resolveAppPaths>;
  database: Awaited<ReturnType<typeof openDatabase>>;
  settings: SettingsRepository;
  apiKey: ApiKeyManager;
  logger: StructuredLogger;
}

let servicesPromise: Promise<PlatformServices> | undefined;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function createPlatformServices(): Promise<PlatformServices> {
  const paths = resolveAppPaths({ environment: env });
  await ensureAppPaths(paths);
  const database = await openDatabase(paths.database);
  seedImageRegistry(database);
  seedVideoRegistry(database);
  const logger = new StructuredLogger({
    directory: paths.logs,
    separateErrorFile: env.PLS_LOG_SEPARATE_ERRORS !== 'false',
    maxBytes: positiveInteger(env.PLS_LOG_MAX_BYTES, 5 * 1024 * 1024),
    maxAgeMs: positiveInteger(env.PLS_LOG_MAX_AGE_MS, 24 * 60 * 60 * 1000),
    retentionAgeMs: positiveInteger(env.PLS_LOG_RETENTION_AGE_MS, 14 * 24 * 60 * 60 * 1000),
    maxRotatedFiles: positiveInteger(env.PLS_LOG_MAX_FILES, 10)
  });
  const settings = new SettingsRepository(database);
  const storedLoggerSettings = settings.get<{
    logs?: Parameters<typeof logger.updateRotationSettings>[0];
  }>('operations')?.value.logs;
  if (storedLoggerSettings) {
    try {
      logger.updateRotationSettings(storedLoggerSettings);
    } catch {
      // Invalid persisted settings fail closed to validated environment defaults.
    }
  }
  const secretStore = await createPreferredSecretStore({ paths });
  const apiKey = new ApiKeyManager({
    environment: env,
    secretStore,
    metadataRepository: new SecretMetadataRepository(database)
  });
  await logger.info('platform.started', {
    data: {
      schemaVersion: DATABASE_SCHEMA_VERSION,
      appDataSource: paths.source,
      secretStore: secretStore.kind
    }
  });

  return {
    paths,
    database,
    settings,
    apiKey,
    logger
  };
}

export async function getPlatformServices(): Promise<PlatformServices> {
  servicesPromise ??= createPlatformServices().catch((error) => {
    servicesPromise = undefined;
    throw error;
  });
  return servicesPromise;
}
