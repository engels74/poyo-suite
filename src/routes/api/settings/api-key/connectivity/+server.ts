import { createPoyoClient } from '$lib/server/poyo/factory';
import { getPlatformServices } from '$lib/server/platform/runtime';
import { readSameOriginJson } from '$lib/server/platform/request-security';
import { operationsHttpError } from '$lib/server/operations/http';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
  let platform: Awaited<ReturnType<typeof getPlatformServices>> | undefined;
  try {
    await readSameOriginJson<Record<string, never>>(request, { maxBytes: 1024 });
    platform = await getPlatformServices();
    const balance = await (
      await createPoyoClient({ apiKeyManager: platform.apiKey, logger: platform.logger })
    ).getBalance();
    platform.database
      .query('INSERT INTO balance_snapshots(email,credits,source,fetched_at) VALUES (?,?,?,?)')
      .run(balance.email, balance.creditsAmount, 'connectivity', balance.fetchedAt);
    platform.apiKey.recordConnectivity('ok');
    return Response.json({
      connectivity: { status: 'ok', checkedAt: balance.fetchedAt, account: balance.email }
    });
  } catch (error) {
    platform?.apiKey.recordConnectivity('failed');
    return operationsHttpError(error);
  }
};
