import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { PresetValues } from '../../../src/lib/features/presets/types';
import { migrateDatabase } from '../../../src/lib/server/platform/database';
import { PresetRepository } from '../../../src/lib/server/presets/repository';

function repository(): { database: Database; repository: PresetRepository } {
  const database = new Database(':memory:', { strict: true });
  migrateDatabase(database);
  return {
    database,
    repository: new PresetRepository(database, () => new Date('2026-07-15T12:00:00.000Z'))
  };
}

function persistedValues(database: Database, id: string): PresetValues {
  const row = database
    .query<{ values_json: string }, [string]>('SELECT values_json FROM presets WHERE id=?')
    .get(id);
  if (!row) throw new Error(`Missing preset ${id}`);
  return JSON.parse(row.values_json) as PresetValues;
}

describe('durable studio presets', () => {
  test('PRESET-01 saves, updates, lists, loads and deletes a versioned preset', () => {
    const fixture = repository();
    try {
      const saved = fixture.repository.save({
        entryKey: 'seedream-5.0-pro:text-to-image',
        name: 'Editorial square',
        description: 'A reusable restrained portrait setup.',
        values: {
          version: 1,
          modality: 'image',
          guided: {
            prompt: 'quiet editorial portrait',
            aspectRatio: '1:1',
            enableSafetyChecker: false
          },
          expertOverrides: [],
          inputRoles: []
        }
      });
      expect(saved.registryVersion).toBeTruthy();
      expect(fixture.repository.list()).toEqual([saved]);
      const updated = fixture.repository.save({
        id: saved.id,
        entryKey: saved.entryKey,
        name: 'Editorial portrait',
        ...(saved.description ? { description: saved.description } : {}),
        values: saved.values
      });
      expect(updated.id).toBe(saved.id);
      expect(updated.name).toBe('Editorial portrait');
      expect(fixture.repository.delete(saved.id)).toBe(true);
      expect(fixture.repository.get(saved.id)).toBeNull();
    } finally {
      fixture.database.close();
    }
  });

  test('PRESET-02 rejects credentials, media bodies and unavailable model workflows', () => {
    const fixture = repository();
    try {
      const values = {
        version: 1 as const,
        modality: 'image' as const,
        guided: {},
        expertOverrides: [],
        inputRoles: []
      };
      expect(() =>
        fixture.repository.save({
          entryKey: 'seedream-5.0-pro:text-to-image',
          name: 'Secret',
          values: { ...values, guided: { apiKey: 'never-store-this' } }
        })
      ).toThrow('credential');
      expect(() =>
        fixture.repository.save({
          entryKey: 'seedream-5.0-pro:text-to-image',
          name: 'Body',
          values: { ...values, guided: { body: new Blob(['media']) } }
        })
      ).toThrow('media bodies');
      expect(() =>
        fixture.repository.save({ entryKey: 'unknown:model', name: 'Unknown', values })
      ).toThrow('unknown');
    } finally {
      fixture.database.close();
    }
  });

  test('PRESET-03 preserves supported output counts and unrelated expert values', () => {
    const fixture = repository();
    try {
      const supporting = fixture.repository.save({
        entryKey: 'flux-schnell:text-to-image',
        name: 'Two Flux outputs',
        values: {
          version: 1,
          modality: 'image',
          guided: { prompt: 'Two images', n: 2 },
          expertOverrides: [],
          inputRoles: []
        }
      });
      expect(supporting.values.guided.n).toBe(2);

      const unrelated = fixture.repository.save({
        entryKey: 'flux-2-pro:text-to-image',
        name: 'Unrelated expert n',
        values: {
          version: 1,
          modality: 'image',
          guided: { prompt: 'One image', aspectRatio: '1:1', resolution: '1K' },
          expertOverrides: [{ key: 'n', value: 6 }],
          inputRoles: []
        }
      });
      expect(unrelated.values.expertOverrides).toEqual([{ key: 'n', value: 6 }]);
      expect(persistedValues(fixture.database, supporting.id)).toEqual(supporting.values);
      expect(persistedValues(fixture.database, unrelated.id)).toEqual(unrelated.values);
    } finally {
      fixture.database.close();
    }
  });

  test('PRESET-04 filters stale WAN rows and round-trips the current exact workflow', () => {
    const fixture = repository();
    try {
      const values: PresetValues = {
        version: 1,
        modality: 'video',
        guided: { prompt: 'Animate', aspectRatio: '16:9', resolution: '720p', duration: 2 },
        expertOverrides: [],
        inputRoles: []
      };
      fixture.database
        .query(
          `INSERT INTO presets(id,registry_version,entry_key,workflow,name,description,values_version,values_json,created_at,updated_at)
           VALUES (?,?,?,?,?,?,1,?,?,?)`
        )
        .run(
          'stale-wan',
          'video-legacy',
          'wan2.7-image-to-video:frame-to-video',
          'frame-to-video',
          'Stale WAN',
          null,
          JSON.stringify(values),
          '2026-07-14T00:00:00.000Z',
          '2026-07-15T00:00:00.000Z'
        );
      fixture.database
        .query(
          `INSERT INTO presets(id,registry_version,entry_key,workflow,name,description,values_version,values_json,created_at,updated_at)
           VALUES (?,?,?,?,?,?,1,?,?,?)`
        )
        .run(
          'stale-version',
          'video-legacy',
          'wan2.7-image-to-video:image-to-video',
          'image-to-video',
          'Stale version',
          null,
          JSON.stringify(values),
          '2026-07-14T00:00:00.000Z',
          '2026-07-15T00:00:00.000Z'
        );

      expect(fixture.repository.get('stale-wan')).toBeNull();
      expect(fixture.repository.get('stale-version')).toBeNull();
      expect(fixture.repository.list()).toEqual([]);
      expect(() =>
        fixture.repository.save({
          entryKey: 'wan2.7-image-to-video:frame-to-video',
          name: 'Rejected stale WAN',
          values
        })
      ).toThrow('unknown');

      const saved = fixture.repository.save({
        entryKey: 'wan2.7-image-to-video:image-to-video',
        name: 'Current WAN',
        values
      });

      expect(saved).toMatchObject({
        entryKey: 'wan2.7-image-to-video:image-to-video',
        workflow: 'image-to-video',
        values
      });
      expect(persistedValues(fixture.database, saved.id)).toEqual(values);
      expect(
        fixture.database
          .query<{ entry_key: string; workflow: string }, [string]>(
            'SELECT entry_key,workflow FROM presets WHERE id=?'
          )
          .get(saved.id)
      ).toEqual({
        entry_key: 'wan2.7-image-to-video:image-to-video',
        workflow: 'image-to-video'
      });
      fixture.database.query('UPDATE presets SET values_version=2 WHERE id=?').run(saved.id);
      expect(fixture.repository.get(saved.id)).toBeNull();
    } finally {
      fixture.database.close();
    }
  });
});
