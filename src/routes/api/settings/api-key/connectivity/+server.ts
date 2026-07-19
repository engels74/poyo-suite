import { createPoyoClient } from '$lib/server/poyo/factory';
import { getPlatformServices } from '$lib/server/platform/runtime';
import { readSameOriginJson } from '$lib/server/platform/request-security';
import { operationsHttpError } from '$lib/server/operations/http';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
  try {
    await readSameOriginJson<Record<string, never>>(request, { maxBytes: 1024 });
    const platform = await getPlatformServices();
    const balance = await platform.apiKey.verifyConnectivity(async (resolved) => {
      const client = await createPoyoClient({
        apiKeyManager: { resolve: () => Promise.resolve(resolved) },
        logger: platform.logger,
        environment: platform.environment,
        publicIpv4Guard: platform.publicIpv4
      });
      const balance = await client.getBalance();
      platform.database
        .query('INSERT INTO balance_snapshots(email,credits,source,fetched_at) VALUES (?,?,?,?)')
        .run(balance.email, balance.creditsAmount, 'connectivity', balance.fetchedAt);
      return balance;
    });
    return Response.json({
      connectivity: {
        status: 'ok',
        checkedAt: platform.apiKey.connectivityStatus().checkedAt,
        account: balance.email
      }
    });
  } catch (error) {
    return operationsHttpError(error);
  }
};
