import type { Database } from 'bun:sqlite';
import { createPoyoClient } from '../poyo/factory';
import type { PlatformServices } from '../platform/runtime';

export interface BalanceSnapshotDto {
  email: string | null;
  credits: number;
  source: string;
  fetchedAt: string;
}

type BalanceRow = {
  email: string | null;
  credits: number;
  source: string;
  fetched_at: string;
};

export function latestBalance(database: Database): BalanceSnapshotDto | null {
  const row = database
    .query<BalanceRow, []>(
      "SELECT email,credits,source,fetched_at FROM balance_snapshots WHERE source NOT LIKE 'cost:v1:%' ORDER BY fetched_at DESC,id DESC LIMIT 1"
    )
    .get();
  return row
    ? { email: row.email, credits: row.credits, source: row.source, fetchedAt: row.fetched_at }
    : null;
}

export async function refreshBalance(platform: PlatformServices): Promise<BalanceSnapshotDto> {
  const client = await createPoyoClient({
    apiKeyManager: platform.apiKey,
    logger: platform.logger,
    environment: platform.environment,
    publicIpv4Guard: platform.publicIpv4
  });
  const balance = await client.getBalance();
  platform.database
    .query('INSERT INTO balance_snapshots(email,credits,source,fetched_at) VALUES (?,?,?,?)')
    .run(balance.email, balance.creditsAmount, 'manual', balance.fetchedAt);
  return {
    email: balance.email,
    credits: balance.creditsAmount,
    source: 'manual',
    fetchedAt: balance.fetchedAt
  };
}
