import type { Migration } from './types';
import { initialMigration } from './0001-initial';
import { cleanupOperationsMigration } from './0002-cleanup-operations';

export const migrations: readonly Migration[] = [initialMigration, cleanupOperationsMigration];

export type { AppliedMigration, Migration } from './types';
