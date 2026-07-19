import { operationsHttpError } from '$lib/server/operations/http';
import { getPlatformServices } from '$lib/server/platform/runtime';
import { readSameOriginJson } from '$lib/server/platform/request-security';
import type { RequestHandler } from './$types';

const noStore = { 'cache-control': 'no-store' };

export const GET: RequestHandler = async () => {
  const platform = await getPlatformServices();
  return Response.json(
    {
      settings: platform.publicIpv4.readSettings(),
      status: await platform.publicIpv4.status()
    },
    { headers: noStore }
  );
};

export const PUT: RequestHandler = async ({ request }) => {
  try {
    const body = await readSameOriginJson<unknown>(request, { maxBytes: 4 * 1024 });
    const platform = await getPlatformServices();
    const settings = platform.publicIpv4.saveSettings(body);
    return Response.json(
      { settings, status: await platform.publicIpv4.status() },
      { headers: noStore }
    );
  } catch (error) {
    return operationsHttpError(error);
  }
};
