import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { migrateDatabase } from '../../../src/lib/server/platform/database';
import { ModelPreferenceRepository } from '../../../src/lib/server/registry/preferences-repository';

describe('model preference compatibility', () => {
  test('filters stale WAN preferences and round-trips the current exact key', () => {
    const database = new Database(':memory:', { strict: true });
    migrateDatabase(database);
    try {
      database
        .query(
          'INSERT INTO model_preferences(entry_key,favorite,favorited_at,last_used_at) VALUES (?,?,?,?)'
        )
        .run(
          'wan2.7-image-to-video:frame-to-video',
          1,
          '2026-07-20T00:00:00.000Z',
          '2026-07-20T00:00:00.000Z'
        );
      database
        .query(
          'INSERT INTO model_preferences(entry_key,favorite,favorited_at,last_used_at) VALUES (?,?,?,?)'
        )
        .run('wan2.7-image-to-video:image-to-video', 0, null, '2026-07-19T00:00:00.000Z');
      const repository = new ModelPreferenceRepository(
        database,
        () => new Date('2026-07-20T01:00:00.000Z')
      );

      expect(repository.list()).toEqual([
        {
          entryKey: 'wan2.7-image-to-video:image-to-video',
          favorite: false,
          favoritedAt: null,
          lastUsedAt: '2026-07-19T00:00:00.000Z'
        }
      ]);
      expect(() => repository.save('wan2.7-image-to-video:frame-to-video', { used: true })).toThrow(
        'invalid'
      );
      expect(repository.save('wan2.7-image-to-video:image-to-video', { used: true })).toEqual({
        entryKey: 'wan2.7-image-to-video:image-to-video',
        favorite: false,
        favoritedAt: null,
        lastUsedAt: '2026-07-20T01:00:00.000Z'
      });
      expect(
        database
          .query<{ entry_key: string; last_used_at: string | null }, [string]>(
            'SELECT entry_key,last_used_at FROM model_preferences WHERE entry_key=?'
          )
          .get('wan2.7-image-to-video:frame-to-video')
      ).toEqual({
        entry_key: 'wan2.7-image-to-video:frame-to-video',
        last_used_at: '2026-07-20T00:00:00.000Z'
      });
    } finally {
      database.close();
    }
  });
});
