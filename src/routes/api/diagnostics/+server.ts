import { getCleanupRuntime } from '$lib/server/cleanup/runtime';
import { buildOperationsDiagnostics } from '$lib/server/diagnostics/operations';
import { getPlatformServices } from '$lib/server/platform/runtime';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ setHeaders }) => {
  setHeaders({ 'cache-control': 'no-store' });
  try {
    const [platform, cleanup] = await Promise.all([getPlatformServices(), getCleanupRuntime()]);
    return Response.json({ diagnostics: await buildOperationsDiagnostics(platform, cleanup) });
  } catch {
    return Response.json(
      {
        diagnostics: {
          status: 'degraded',
          error: {
            name: 'DiagnosticsUnavailable',
            message: 'Redacted diagnostics could not be collected. Review local logs.'
          }
        }
      },
      { status: 503 }
    );
  }
};
