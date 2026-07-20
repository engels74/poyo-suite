import { env } from '$env/dynamic/private';
import { StructuredLogger } from '../diagnostics/jsonl-logger';
import { MediaToolReadinessService } from '../media/media-tool-readiness';
import { recoverSourceIntakeTemporaries } from '../media/source-intake';
import { PublicPricingService } from '../pricing/public-pricing';
import { seedImageRegistry, seedVideoRegistry } from '../registry/repository';
import { ApiKeyManager } from '../settings/api-key-manager';
import { SecretMetadataRepository } from '../settings/secret-metadata-repository';
import { createSecretStore } from '../settings/secret-store';
import { SettingsRepository } from '../settings/settings-repository';
import { ensureAppPaths, resolveAppPaths } from './app-paths';
import { openDatabase, preflightDatabase } from './database';
import { maintenanceGate } from './maintenance-gate';
import { PublicIpv4Service } from './public-ipv4';
import { DATABASE_SCHEMA_VERSION } from './version';

export interface PlatformServices {
  environment: Record<string, string | undefined>;
  paths: ReturnType<typeof resolveAppPaths>;
  database: Awaited<ReturnType<typeof openDatabase>>;
  settings: SettingsRepository;
  apiKey: ApiKeyManager;
  logger: StructuredLogger;
  publicIpv4: PublicIpv4Service;
  pricing: PublicPricingService;
  mediaTools: MediaToolReadinessService;
}

let servicesPromise: Promise<PlatformServices> | undefined;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function createPlatformServices(): Promise<PlatformServices> {
  const paths = resolveAppPaths({ environment: env });

  return maintenanceGate.withWriterPermit('platform.startup', async () => {
    let database: Awaited<ReturnType<typeof openDatabase>> | null = null;
    try {
      await ensureAppPaths(paths);
      const recoveredSourceTemporaries = await recoverSourceIntakeTemporaries(paths);
      await preflightDatabase(paths.database);
      database = await openDatabase(paths.database);
      seedImageRegistry(database);
      seedVideoRegistry(database);

      const logger = new StructuredLogger({
        directory: paths.logs,
        separateErrorFile: env.PLS_LOG_SEPARATE_ERRORS !== 'false',
        maxBytes: positiveInteger(env.PLS_LOG_MAX_BYTES, 5 * 1024 * 1024),
        maxAgeMs: positiveInteger(env.PLS_LOG_MAX_AGE_MS, 24 * 60 * 60 * 1000),
        retentionAgeMs: positiveInteger(env.PLS_LOG_RETENTION_AGE_MS, 14 * 24 * 60 * 60 * 1000),
        maxRotatedFiles: positiveInteger(env.PLS_LOG_MAX_FILES, 10),
        gate: maintenanceGate
      });
      await logger.recoverPendingClears();
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

      const secretStore = createSecretStore({ paths });
      const apiKey = new ApiKeyManager({
        environment: env,
        secretStore,
        metadataRepository: new SecretMetadataRepository(database),
        mutationGate: maintenanceGate
      });
      const publicIpv4 = new PublicIpv4Service({ settings, environment: env });
      const pricing = new PublicPricingService({
        settings,
        gate: maintenanceGate,
        reportFailure: (category) =>
          logger.warn('pricing.refresh_failed', { data: { category } }).catch(() => undefined)
      });
      const mediaTools = new MediaToolReadinessService();
      await logger.info('platform.started', {
        data: {
          schemaVersion: DATABASE_SCHEMA_VERSION,
          appDataSource: paths.source,
          credentialBackend: secretStore.kind,
          recoveredSourceTemporaries
        }
      });
      maintenanceGate.registerDrain('logger', () => logger.suspendAndDrain());

      return {
        environment: env,
        paths,
        database,
        settings,
        apiKey,
        logger,
        publicIpv4,
        pricing,
        mediaTools
      };
    } catch (error) {
      database?.close();
      throw error;
    }
  });
}

export async function getPlatformServices(): Promise<PlatformServices> {
  servicesPromise ??= createPlatformServices().catch((error) => {
    servicesPromise = undefined;
    throw error;
  });
  return servicesPromise;
}
