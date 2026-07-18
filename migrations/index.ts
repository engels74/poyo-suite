import { initialMigration } from './0001-initial';
import type { Migration } from './types';

export const migrations: readonly Migration[] = [initialMigration];

export type { AppliedMigration, Migration } from './types';
