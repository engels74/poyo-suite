import { REMOTE_CLEANUP_CAPABILITY } from '$lib/features/cleanup/contracts';
import { getCleanupRuntime } from '$lib/server/cleanup/runtime';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ setHeaders }) => {
  setHeaders({ 'cache-control': 'no-store' });
  const runtime = await getCleanupRuntime();
  return Response.json({
    local: { policy: runtime.options.service.policy(), state: runtime.diagnostics() },
    remote: REMOTE_CLEANUP_CAPABILITY
  });
};
