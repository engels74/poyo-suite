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

  test.each([
    ['seedream-5.0-pro:text-to-image', 'guided'],
    ['seedream-5.0-pro:text-to-image', 'expert'],
    ['seedream-5.0-pro-edit:image-edit', 'guided'],
    ['seedream-5.0-pro-edit:image-edit', 'expert']
  ] as const)(
    'PRESET-03 strips retired n for %s raw %s input without mutating the caller',
    (entryKey, carrier) => {
      const fixture = repository();
      try {
        const values: PresetValues = {
          version: 1,
          modality: 'image',
          guided: {
            prompt: 'Retain current settings',
            aspectRatio: '16:9',
            resolution: '2K',
            ...(carrier === 'guided' ? { n: 6 } : {})
          },
          expertOverrides: [
            { key: 'first_parameter', value: 1 },
            ...(carrier === 'expert' ? [{ key: 'n', value: 6 }] : []),
            { key: 'last_parameter', value: { mode: 'kept' } }
          ],
          inputRoles: []
        };
        const before = structuredClone(values);
        const saved = fixture.repository.save({ entryKey, name: `${entryKey} ${carrier}`, values });

        expect(values).toEqual(before);
        expect(saved.values.guided).toEqual({
          prompt: 'Retain current settings',
          aspectRatio: '16:9',
          resolution: '2K'
        });
        expect(saved.values.expertOverrides).toEqual([
          { key: 'first_parameter', value: 1 },
          { key: 'last_parameter', value: { mode: 'kept' } }
        ]);
        expect(persistedValues(fixture.database, saved.id)).toEqual(saved.values);
      } finally {
        fixture.database.close();
      }
    }
  );

  test('PRESET-04 preserves a legacy row until explicit save then sanitizes it in place', () => {
    const fixture = repository();
    try {
      const id = crypto.randomUUID();
      const createdAt = '2026-07-14T10:00:00.000Z';
      const legacyValues: PresetValues = {
        version: 1,
        modality: 'image',
        guided: { prompt: 'Legacy preset', n: 6, resolution: '1K' },
        expertOverrides: [
          { key: 'n', value: 6 },
          { key: 'future_parameter', value: { mode: 'kept' } }
        ],
        inputRoles: []
      };
      fixture.database
        .query(
          `INSERT INTO presets(id,registry_version,entry_key,workflow,name,description,values_version,values_json,created_at,updated_at)
           VALUES (?,?,?,?,?,?,1,?,?,?)`
        )
        .run(
          id,
          'legacy-image-registry',
          'seedream-5.0-pro:text-to-image',
          'text-to-image',
          'Legacy Pro',
          null,
          JSON.stringify(legacyValues),
          createdAt,
          createdAt
        );

      const legacy = fixture.repository.get(id);
      expect(legacy?.values).toEqual(legacyValues);
      if (!legacy) throw new Error('Missing legacy preset.');
      const saved = fixture.repository.save({
        id,
        entryKey: legacy.entryKey,
        name: legacy.name,
        values: legacy.values
      });

      expect(saved.id).toBe(id);
      expect(saved.createdAt).toBe(createdAt);
      expect(saved.values.guided).toEqual({ prompt: 'Legacy preset', resolution: '1K' });
      expect(saved.values.expertOverrides).toEqual([
        { key: 'future_parameter', value: { mode: 'kept' } }
      ]);
      expect(persistedValues(fixture.database, id)).toEqual(saved.values);
    } finally {
      fixture.database.close();
    }
  });

  test('PRESET-05 preserves supported and unrelated non-Pro n values', () => {
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
});
