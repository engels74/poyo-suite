import { env } from '$env/dynamic/private';
import { startRuntimeCleanupWorker } from '$lib/server/cleanup/runtime';
import { startRuntimeJobWorker } from '$lib/server/jobs/runtime';
import { resolveAppPathCandidates } from '$lib/server/platform/app-paths';
import {
  MaintenanceUnavailableError,
  maintenanceGate
} from '$lib/server/platform/maintenance-gate';
import { RequestSecurityError, readSameOriginJson } from '$lib/server/platform/request-security';
import {
  RootRelocationCoordinator,
  RootRelocationError
} from '$lib/server/platform/root-relocation';
import {
  pendingStorageRootStatusDto,
  storageRootStatusDto
} from '$lib/server/platform/root-status';
import { RelocationTopologyError } from '$lib/server/platform/root-topology';
import { getPlatformServices } from '$lib/server/platform/runtime';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ setHeaders }) => {
  setHeaders({ 'cache-control': 'no-store' });
  const platform = await getPlatformServices();
  const candidates = resolveAppPathCandidates({ environment: platform.environment });
  return Response.json({
    storageRoot: await storageRootStatusDto({
      paths: platform.paths,
      runtime: platform.storageRootRuntime,
      gate: maintenanceGate,
      database: platform.database,
      candidateRoots: [candidates.project.root, candidates.platform.root],
      environment: platform.environment
    })
  });
};

function safeError(error: unknown): Response {
  if (error instanceof RequestSecurityError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status }
    );
  }
  if (error instanceof MaintenanceUnavailableError) {
    return Response.json(
      {
        error: {
          code: 'maintenance_frozen',
          message: 'Local storage maintenance is already in progress.'
        }
      },
      { status: 503 }
    );
  }
  if (error instanceof RelocationTopologyError || error instanceof RootRelocationError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.code === 'insufficient_space' ? 422 : 409 }
    );
  }
  return Response.json(
    {
      error: {
        code: 'relocation_failed',
        message: 'The local storage root could not be relocated safely.'
      }
    },
    { status: 500 }
  );
}

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await readSameOriginJson<{ targetRootKind?: unknown }>(request, {
      maxBytes: 1024
    });
    if (body.targetRootKind !== 'project' && body.targetRootKind !== 'platform') {
      return Response.json(
        {
          error: {
            code: 'invalid_target',
            message: 'A project or platform storage root is required.'
          }
        },
        { status: 400 }
      );
    }

    const platform = await getPlatformServices();
    const targetRootKind = body.targetRootKind;
    const candidates = resolveAppPathCandidates({ environment: env });
    if (platform.paths.rootKind === 'environment') {
      return Response.json(
        {
          error: {
            code: 'environment_root_managed',
            message: 'PLS_APP_DATA_DIR controls the application root.'
          }
        },
        { status: 409 }
      );
    }
    if (platform.paths.rootKind === targetRootKind) {
      return Response.json(
        { error: { code: 'same_root', message: 'The requested root is already active.' } },
        { status: 409 }
      );
    }

    const target = targetRootKind === 'project' ? candidates.project : candidates.platform;
    const initiator = maintenanceGate.acquireMaintenanceInitiator('http:storage-root-relocation');
    const result = await new RootRelocationCoordinator({
      source: platform.paths,
      target,
      database: platform.database,
      environment: platform.environment,
      gate: maintenanceGate,
      resumeBeforePublication: async () => {
        platform.logger.resumeBeforePublication();
        await Promise.all([startRuntimeJobWorker(), startRuntimeCleanupWorker()]);
      }
    }).relocate(initiator);
    return Response.json(
      {
        relocation: {
          targetRootKind: result.targetRootKind,
          restartRequired: result.restartRequired
        },
        storageRoot: await pendingStorageRootStatusDto({
          currentRootKind: platform.paths.rootKind,
          targetRootKind,
          database: platform.database,
          candidateRoots: [candidates.project.root, candidates.platform.root],
          environment: platform.environment
        })
      },
      { status: 202 }
    );
  } catch (error) {
    return safeError(error);
  }
};
