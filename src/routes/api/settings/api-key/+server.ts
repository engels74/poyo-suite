import { getPlatformServices } from '$lib/server/platform/runtime';
import { readSameOriginJson } from '$lib/server/platform/request-security';
import { operationsHttpError } from '$lib/server/operations/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ setHeaders }) => {
  setHeaders({ 'cache-control': 'no-store' });
  const platform = await getPlatformServices();
  return Response.json({ apiKey: await platform.apiKey.status() });
};

export const PUT: RequestHandler = async ({ request }) => {
  try {
    const body = await readSameOriginJson<{ apiKey?: unknown }>(request, { maxBytes: 8 * 1024 });
    if (typeof body.apiKey !== 'string') throw new Error('API key is required.');
    const platform = await getPlatformServices();
    return Response.json({ apiKey: await platform.apiKey.setLocal(body.apiKey) });
  } catch (error) {
    return operationsHttpError(error);
  }
};

export const DELETE: RequestHandler = async ({ request }) => {
  try {
    await readSameOriginJson<Record<string, never>>(request, { maxBytes: 1024 });
    const platform = await getPlatformServices();
    return Response.json({ apiKey: await platform.apiKey.removeLocal() });
  } catch (error) {
    return operationsHttpError(error);
  }
};
