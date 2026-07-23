import type { Database } from 'bun:sqlite';
import { IMAGE_REGISTRY_ENTRIES } from '../../features/registry/image-registry';
import { VIDEO_REGISTRY_ENTRIES } from '../../features/registry/video-registry';
import { DatabaseRepository } from '../platform/repository';

export interface ModelPreference {
  entryKey: string;
  favorite: boolean;
  favoritedAt: string | null;
  lastUsedAt: string | null;
}

type PreferenceRow = {
  entry_key: string;
  favorite: number;
  favorited_at: string | null;
  last_used_at: string | null;
};

function isCurrentEntryKey(entryKey: string): boolean {
  return (
    IMAGE_REGISTRY_ENTRIES.some((entry) => entry.key === entryKey && entry.status === 'current') ||
    VIDEO_REGISTRY_ENTRIES.some((entry) => entry.key === entryKey && entry.status === 'current')
  );
}

function mapPreference(row: PreferenceRow): ModelPreference {
  return {
    entryKey: row.entry_key,
    favorite: row.favorite === 1,
    favoritedAt: row.favorited_at,
    lastUsedAt: row.last_used_at
  };
}

export class ModelPreferenceRepository extends DatabaseRepository {
  constructor(
    database: Database,
    private readonly now: () => Date = () => new Date()
  ) {
    super(database);
  }

  list(): ModelPreference[] {
    const preferences = this.database
      .query<PreferenceRow, []>(
        'SELECT entry_key,favorite,favorited_at,last_used_at FROM model_preferences ORDER BY favorite DESC,last_used_at DESC'
      )
      .all();
    return preferences.filter((row) => isCurrentEntryKey(row.entry_key)).map(mapPreference);
  }

  save(entryKey: string, update: { favorite?: boolean; used?: boolean }): ModelPreference {
    if (!entryKey.trim() || entryKey.length > 512 || !isCurrentEntryKey(entryKey))
      throw new Error('Model preference key is invalid.');
    const now = this.now().toISOString();
    this.database
      .query(
        `INSERT INTO model_preferences(entry_key,favorite,favorited_at,last_used_at) VALUES (?,?,?,?)
         ON CONFLICT(entry_key) DO UPDATE SET
           favorite=COALESCE(?,model_preferences.favorite),
           favorited_at=CASE WHEN ? IS NULL THEN model_preferences.favorited_at WHEN ?=1 THEN ? ELSE NULL END,
           last_used_at=COALESCE(?,model_preferences.last_used_at)`
      )
      .run(
        entryKey,
        update.favorite ? 1 : 0,
        update.favorite ? now : null,
        update.used ? now : null,
        update.favorite === undefined ? null : update.favorite ? 1 : 0,
        update.favorite === undefined ? null : update.favorite ? 1 : 0,
        update.favorite ? 1 : 0,
        now,
        update.used ? now : null
      );
    const row = this.database
      .query<PreferenceRow, [string]>(
        'SELECT entry_key,favorite,favorited_at,last_used_at FROM model_preferences WHERE entry_key=?'
      )
      .get(entryKey);
    if (!row) throw new Error('Model preference could not be saved.');
    return mapPreference(row);
  }
}
