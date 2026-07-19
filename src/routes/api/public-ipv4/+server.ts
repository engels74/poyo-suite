import { operationsHttpError } from '$lib/server/operations/http';
import { getPlatformServices } from '$lib/server/platform/runtime';
import { readSameOriginJson } from '$lib/server/platform/request-security';
import type { RequestHandler } from './$types';

const noStore = { 'cache-control': 'no-store' };

export const GET: RequestHandler = async () => {
  const platform = await getPlatformServices();
  return Response.json({ status: await platform.publicIpv4.status() }, { headers: noStore });
};

export const POST: RequestHandler = async ({ request }) => {
  try {
    await readSameOriginJson<Record<string, never>>(request, { maxBytes: 1024 });
    const platform = await getPlatformServices();
    return Response.json(
      { status: await platform.publicIpv4.status({ refresh: true }) },
      { headers: noStore }
    );
  } catch (error) {
    return operationsHttpError(error);
  }
};
