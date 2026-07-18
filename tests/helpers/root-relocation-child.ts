import type { AppPaths } from '../../src/lib/server/platform/app-paths';
import { openDatabase } from '../../src/lib/server/platform/database';
import { MaintenanceGate } from '../../src/lib/server/platform/maintenance-gate';
import {
  type RelocationCheckpoint,
  RootRelocationCoordinator
} from '../../src/lib/server/platform/root-relocation';

const input = JSON.parse(process.argv[2] ?? '{}') as {
  source: AppPaths;
  target: AppPaths;
  checkpoint: RelocationCheckpoint;
};

const database = await openDatabase(input.source.database);
const gate = new MaintenanceGate();
await new RootRelocationCoordinator({
  source: input.source,
  target: input.target,
  database,
  environment: {},
  gate,
  platform: 'linux',
  checkpoint: (checkpoint) => {
    if (checkpoint === input.checkpoint) process.exit(79);
  }
}).relocate(gate.acquireMaintenanceInitiator('process-kill-fixture'));
database.close();
