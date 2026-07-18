import { env } from '$env/dynamic/private';
import { StructuredLogger } from '../diagnostics/jsonl-logger';
import { ManagedSourceRepository } from '../media/managed-sources';
import { seedImageRegistry, seedVideoRegistry } from '../registry/repository';
import { ApiKeyManager } from '../settings/api-key-manager';
import { SecretMetadataRepository } from '../settings/secret-metadata-repository';
import { createCredentialSecretStores } from '../settings/secret-store';
import { SettingsRepository } from '../settings/settings-repository';
import { readStoragePreferences, resolveEffectiveMedia } from '../settings/studio-settings';
import {
  ensureAppPaths,
  ensureDirectoryExists,
  resolveAppPathCandidates,
  resolveAppPaths
} from './app-paths';
import { openDatabase } from './database';
import { maintenanceGate } from './maintenance-gate';
import {
  applyExternalDatabaseRebase,
  beginProvisionalActivation,
  completeStartupRelocation,
  resolveStartupRelocation,
  rollbackProvisionalActivation,
  type StartupRelocationContext
} from './root-relocation';
import type { StorageRootRuntimeStatus } from './root-status';
import {
  createInitialProjectMarker,
  preflightEnvironmentRoot,
  promoteInitialProjectMarker,
  type RootMarkerV1,
  selectRootForStartup,
  writeRootMarker
} from './root-selector';
import { DATABASE_SCHEMA_VERSION } from './version';

export interface PlatformServices {
  environment: Record<string, string | undefined>;
  paths: ReturnType<typeof resolveAppPaths>;
  database: Awaited<ReturnType<typeof openDatabase>>;
  settings: SettingsRepository;
  apiKey: ApiKeyManager;
  logger: StructuredLogger;
  storageRootRuntime: StorageRootRuntimeStatus;
}

let servicesPromise: Promise<PlatformServices> | undefined;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function createPlatformServices(): Promise<PlatformServices> {
  const environmentManaged = Boolean(env.PLS_APP_DATA_DIR?.trim());
  let initialMarker: RootMarkerV1 | null = null;
  let relocation: StartupRelocationContext | null = null;
  let basePaths: ReturnType<typeof resolveAppPaths>;
  if (environmentManaged) {
    basePaths = resolveAppPaths({ environment: env });
    await preflightEnvironmentRoot(basePaths);
  } else {
    const candidates = resolveAppPathCandidates({ environment: env });
    const selection = await selectRootForStartup(candidates.project, candidates.platform);
    relocation = await maintenanceGate.withWriterPermit('platform.relocation-recovery', () =>
      resolveStartupRelocation({ selection, candidates, environment: env })
    );
    basePaths = relocation.paths;
    if (selection.decision.mode === 'initialize') {
      initialMarker =
        selection.projectProbe.status === 'valid'
          ? selection.projectProbe.marker
          : createInitialProjectMarker();
    }
  }

  return maintenanceGate.withWriterPermit('platform.startup', async () => {
    let database: Awaited<ReturnType<typeof openDatabase>> | null = null;
    try {
      if (initialMarker) await writeRootMarker(basePaths.root, initialMarker);
      if (relocation?.kind === 'provisional') {
        await beginProvisionalActivation(relocation, env);
      }
      await ensureAppPaths(basePaths);
      database = await openDatabase(basePaths.database);
      if (relocation?.kind === 'provisional') {
        applyExternalDatabaseRebase(relocation, database);
      }
      await new ManagedSourceRepository(database, basePaths).adoptLegacyReferences();
      seedImageRegistry(database);
      seedVideoRegistry(database);

      const logger = new StructuredLogger({
        directory: basePaths.logs,
        separateErrorFile: env.PLS_LOG_SEPARATE_ERRORS !== 'false',
        maxBytes: positiveInteger(env.PLS_LOG_MAX_BYTES, 5 * 1024 * 1024),
        maxAgeMs: positiveInteger(env.PLS_LOG_MAX_AGE_MS, 24 * 60 * 60 * 1000),
        retentionAgeMs: positiveInteger(env.PLS_LOG_RETENTION_AGE_MS, 14 * 24 * 60 * 60 * 1000),
        maxRotatedFiles: positiveInteger(env.PLS_LOG_MAX_FILES, 10),
        gate: maintenanceGate
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

      // Apply the existing media-only preference at startup. Root authority is already fixed and
      // memoized before SQLite or the logger exists; neither this preference nor later maintenance
      // can live-swap the process root.
      const effective = resolveEffectiveMedia(
        basePaths,
        readStoragePreferences(settings),
        Boolean(env.PLS_MEDIA_DIR?.trim())
      );
      const paths = {
        ...basePaths,
        media: effective.media,
        mediaReadRoots: effective.mediaReadRoots
      };
      let unavailableOutputLocation: string | null = null;
      if (paths.media !== basePaths.media) {
        try {
          await ensureDirectoryExists(paths.media);
        } catch {
          unavailableOutputLocation = effective.media;
          paths.media = basePaths.media;
          paths.mediaReadRoots = [
            basePaths.media,
            ...effective.mediaReadRoots.filter((root) => root !== basePaths.media)
          ];
        }
      }

      const secretStores = createCredentialSecretStores({ paths });
      const apiKey = new ApiKeyManager({
        environment: env,
        secretStores,
        metadataRepository: new SecretMetadataRepository(database),
        settingsRepository: settings,
        mutationGate: maintenanceGate
      });
      await apiKey.initialize();
      let storageRootRuntime: StorageRootRuntimeStatus = { cleanupPhase: 'none' };
      if (relocation && relocation.kind !== 'ordinary') {
        const relocationResult = await completeStartupRelocation(relocation, database);
        storageRootRuntime = { cleanupPhase: relocationResult.cleanupPhase };
      }
      if (unavailableOutputLocation) {
        await logger.warn('platform.output_location_unavailable', {
          data: { requested: unavailableOutputLocation, fallback: basePaths.media }
        });
      }
      await logger.info('platform.started', {
        data: {
          schemaVersion: DATABASE_SCHEMA_VERSION,
          appDataSource: paths.source,
          credentialBackend: apiKey.selectedBackend()
        }
      });
      if (initialMarker) {
        await writeRootMarker(basePaths.root, promoteInitialProjectMarker(initialMarker));
      }
      maintenanceGate.registerDrain('logger', () => logger.suspendAndDrain());

      return {
        environment: env,
        paths,
        database,
        settings,
        apiKey,
        logger,
        storageRootRuntime
      };
    } catch (error) {
      if (relocation?.kind === 'provisional' && relocation.targetMarker?.state !== 'active') {
        try {
          await rollbackProvisionalActivation(relocation, database);
        } catch (rollbackError) {
          database?.close();
          throw rollbackError;
        }
      }
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
