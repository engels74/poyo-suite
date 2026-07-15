import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  IMAGE_AUDIT_RECORDS,
  IMAGE_PAGE_SLUGS,
  IMAGE_PUBLIC_IDS,
  IMAGE_REGISTRY,
  IMAGE_REGISTRY_ENTRIES
} from '../../../src/lib/features/registry/image-registry';
import {
  minimumValidRequest,
  normalizeImageRequest,
  RegistryValidationError
} from '../../../src/lib/features/registry/normalize';
import { migrateDatabase } from '../../../src/lib/server/platform/database';
import { seedImageRegistry } from '../../../src/lib/server/registry/repository';

function registryEntry(key: string) {
  const entry = IMAGE_REGISTRY_ENTRIES.find((candidate) => candidate.key === key);
  if (!entry) throw new Error(`Missing registry fixture: ${key}`);
  return entry;
}

describe('audited image registry', () => {
  test('REG-01/02 accounts for all 22 pages, 44 public IDs, and 50 reviewed workflows', () => {
    expect(IMAGE_PAGE_SLUGS).toHaveLength(22);
    expect(new Set(IMAGE_PAGE_SLUGS).size).toBe(22);
    expect(IMAGE_PUBLIC_IDS).toHaveLength(44);
    expect(IMAGE_REGISTRY_ENTRIES).toHaveLength(50);
    expect(new Set(IMAGE_REGISTRY_ENTRIES.map((entry) => entry.key)).size).toBe(50);
    for (const entry of IMAGE_REGISTRY_ENTRIES) {
      expect(entry.provenance.markdownUrl).toStartWith('https://docs.poyo.ai/');
      expect(entry.provenance.markdownSha256).toHaveLength(64);
      expect(entry.provenance.jsonSha256).toHaveLength(64);
      expect(entry.provenance.jsonStatus).toBe('available');
      expect(entry.provenance.sourceManifestVersion).toMatch(/^1:[a-f0-9]{64}$/);
      expect(entry.fields.some((field) => field.level === 'essential')).toBe(true);
      expect(entry.status).toBe('current');
    }
  });
  test('REG-03 every workflow has a functional minimum-valid exact model adapter', () => {
    for (const entry of IMAGE_REGISTRY_ENTRIES) {
      const preview = normalizeImageRequest(entry.key, minimumValidRequest(entry));
      expect(preview.request.model).toBe(entry.publicModelId);
      expect(preview.request.input.prompt).toBe('studio image');
    }
  });
  test('REG-04 validates prompt, reference counts, enums, output counts and custom dimensions', () => {
    const flux = registryEntry('flux-2-pro:text-to-image');
    expect(() =>
      normalizeImageRequest(flux.key, { prompt: 'x', aspectRatio: '1:1', resolution: '1K' })
    ).toThrow('too short');
    const edit = registryEntry('kling-o1-image-edit:image-edit');
    expect(() => normalizeImageRequest(edit.key, { prompt: 'edit' })).toThrow('reference');
    expect(() =>
      normalizeImageRequest(edit.key, {
        prompt: 'edit',
        imageUrls: Array.from({ length: 11 }, (_, i) => `https://assets.example/${i}.png`)
      })
    ).toThrow('At most 10');
    const wan = registryEntry('wan-2.7-image:text-to-image');
    expect(
      normalizeImageRequest(wan.key, { prompt: 'render', width: 1024, height: 768, n: 4, seed: 7 })
        .request.input
    ).toMatchObject({ size: { width: 1024, height: 768 }, n: 4, seed: 7 });
    expect(() =>
      normalizeImageRequest(wan.key, { prompt: 'render', width: 0, height: 768 })
    ).toThrow('positive integer');
    const gpt = registryEntry('gpt-image-2:text-to-image');
    expect(
      normalizeImageRequest(gpt.key, {
        prompt: 'render',
        width: 2304,
        height: 1536,
        resolution: '2K'
      }).request.input.size
    ).toBe('2304x1536');
    expect(() =>
      normalizeImageRequest(gpt.key, {
        prompt: 'render',
        width: 2305,
        height: 1536,
        resolution: '2K'
      })
    ).toThrow('divisible by 16');
  });
  test('REG-04B rejects every malformed runtime field kind before payload transformation', () => {
    const flux = registryEntry('flux-schnell:text-to-image');
    for (const [values, message] of [
      [{ prompt: { injected: true } }, 'prompt must be a string'],
      [{ prompt: null }, 'prompt must be a string'],
      [{ prompt: ['array'] }, 'prompt must be a string'],
      [{ prompt: 'render', n: '2' }, 'n must be an integer'],
      [{ prompt: 'render', n: 1.5 }, 'n must be an integer'],
      [{ prompt: 'render', n: Number.NaN }, 'n must be finite'],
      [
        { prompt: 'render', dimensions: { width: 1024, height: 1024 } },
        'dimensions is not supported'
      ],
      [{ prompt: 'render', unknownField: true }, 'unknownField is not supported']
    ] as const) {
      expect(() =>
        normalizeImageRequest(
          flux.key,
          values as unknown as Parameters<typeof normalizeImageRequest>[1]
        )
      ).toThrow(message);
    }

    expect(() =>
      normalizeImageRequest('seedream-4.5:text-to-image', {
        prompt: 'render',
        enableSafetyChecker: 'false'
      } as unknown as Parameters<typeof normalizeImageRequest>[1])
    ).toThrow('enableSafetyChecker must be boolean');
    expect(() =>
      normalizeImageRequest('kling-o3-image:text-to-image', {
        prompt: 'render',
        elements: [null]
      } as unknown as Parameters<typeof normalizeImageRequest>[1])
    ).toThrow('elements must contain objects');
  });
  test('REG-07 emits explicit false/true only for the four audited image safety families', () => {
    const safetyIds = new Set([
      'seedream-4.5',
      'seedream-4.5-edit',
      'seedream-5.0-lite',
      'seedream-5.0-lite-edit',
      'seedream-5.0-pro',
      'seedream-5.0-pro-edit',
      'z-image'
    ]);
    for (const entry of IMAGE_REGISTRY_ENTRIES) {
      const values = minimumValidRequest(entry);
      const preview = normalizeImageRequest(entry.key, values);
      if (safetyIds.has(entry.publicModelId)) {
        expect(preview.request.input.enable_safety_checker).toBe(false);
        expect(
          normalizeImageRequest(entry.key, { ...values, enableSafetyChecker: true }).request.input
            .enable_safety_checker
        ).toBe(true);
      } else expect(preview.request.input).not.toHaveProperty('enable_safety_checker');
    }
  });
  test('REG-08 Seedream 5 Pro exposes separate concepts but emits exactly one size', () => {
    const entry = registryEntry('seedream-5.0-pro:text-to-image');
    expect(() =>
      normalizeImageRequest(entry.key, { prompt: 'dream', resolution: '1K', aspectRatio: '1:1' })
    ).toThrow('not both');
    expect(
      normalizeImageRequest(entry.key, { prompt: 'dream', resolution: '2K' }).request.input
    ).toMatchObject({ size: '2K', enable_safety_checker: false });
    expect(
      normalizeImageRequest(entry.key, { prompt: 'dream', aspectRatio: '16:9' }).request.input
    ).toMatchObject({ size: '16:9' });
    expect(entry.limitations.join(' ')).toContain('exactly one size');
  });
  test('REG-09 marks controlled unknown expert overrides and blocks protected/verified fields', () => {
    const key = 'flux-schnell:text-to-image';
    const preview = normalizeImageRequest(key, { prompt: 'studio' }, [
      { key: 'future_parameter', value: 3 }
    ]);
    expect(preview.expertDiff).toEqual([
      { key: 'future_parameter', status: 'unverified', value: 3 }
    ]);
    expect(preview.request.input.future_parameter).toBe(3);
    for (const protectedKey of ['model', 'callback_url', 'api_key', 'local_path'])
      expect(() =>
        normalizeImageRequest(key, { prompt: 'studio' }, [{ key: protectedKey, value: 'x' }])
      ).toThrow(RegistryValidationError);
    expect(() =>
      normalizeImageRequest(key, { prompt: 'studio' }, [{ key: 'prompt', value: 'override' }])
    ).toThrow('guided field');
    expect(() =>
      normalizeImageRequest(key, { prompt: 'studio' }, [
        { key: 'future_parameter', value: Number.NaN }
      ])
    ).toThrow('strict JSON');
    expect(() => normalizeImageRequest(key, { prompt: 'studio' }, [null] as unknown as [])).toThrow(
      'key/value objects'
    );
  });
  test('REG-01 seeds the versioned manifest and definitions into SQLite idempotently', () => {
    const database = new Database(':memory:', { strict: true });
    migrateDatabase(database);
    seedImageRegistry(database);
    seedImageRegistry(database);
    expect(
      database.query<{ count: number }, []>('SELECT COUNT(*) count FROM registry_versions').get()
        ?.count
    ).toBe(1);
    expect(
      database.query<{ count: number }, []>('SELECT COUNT(*) count FROM registry_entries').get()
        ?.count
    ).toBe(52);
    expect(
      database
        .query<{ manifest_hash: string }, []>('SELECT manifest_hash FROM registry_versions')
        .get()?.manifest_hash
    ).toBe(IMAGE_REGISTRY.manifestHash);
    database.close();
  });
  test('REG-10 records the now-available paired Kling O3 source evidence', () => {
    const entries = IMAGE_REGISTRY_ENTRIES.filter(
      (entry) => entry.provenance.pageSlug === 'kling-o3'
    );
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.provenance.jsonStatus === 'available')).toBe(true);
    expect(entries.every((entry) => entry.provenance.jsonSha256.length === 64)).toBe(true);
  });
  test('REG-10 retains unindexed duplicate schemas outside current selectors', () => {
    expect(IMAGE_AUDIT_RECORDS).toHaveLength(2);
    expect(IMAGE_AUDIT_RECORDS.every((record) => record.status === 'unindexed')).toBe(true);
    expect(IMAGE_REGISTRY_ENTRIES.some((entry) => entry.key.startsWith('unindexed:'))).toBe(false);
  });
});
