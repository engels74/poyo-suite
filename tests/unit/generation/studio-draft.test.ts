import { beforeEach, describe, expect, test } from 'bun:test';
import type { PresetValues } from '../../../src/lib/features/presets/types';
import {
  clearStudioDraft,
  readStudioDraft,
  writeStudioDraft,
  type StudioDraft
} from '../../../src/lib/features/generation/studio-draft';

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) ?? null) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  get length(): number {
    return this.store.size;
  }
}

beforeEach(() => {
  (globalThis as { localStorage: Storage }).localStorage =
    new MemoryStorage() as unknown as Storage;
});

const values: PresetValues = {
  version: 1,
  modality: 'image',
  guided: { prompt: 'a cat', aspectRatio: '16:9' },
  expertOverrides: [],
  inputRoles: [{ role: 'reference', source: 'remote', urls: ['https://example.com/a.png'] }]
};

const draft: StudioDraft = {
  version: 1,
  entryKey: 'seedream-5-0-pro',
  sizeMode: 'aspect-ratio',
  values
};

describe('studio draft persistence', () => {
  test('round-trips a written draft', () => {
    writeStudioDraft('image', draft);
    expect(readStudioDraft('image')).toEqual(draft);
  });

  test('returns null when nothing is stored', () => {
    expect(readStudioDraft('image')).toBeNull();
  });

  test('isolates image and video drafts', () => {
    writeStudioDraft('image', draft);
    expect(readStudioDraft('video')).toBeNull();
    writeStudioDraft('video', { ...draft, entryKey: 'kling-video' });
    expect(readStudioDraft('image')?.entryKey).toBe('seedream-5-0-pro');
    expect(readStudioDraft('video')?.entryKey).toBe('kling-video');
  });

  test('rejects a wrong version', () => {
    localStorage.setItem('poyo-studio-draft:image', JSON.stringify({ ...draft, version: 2 }));
    expect(readStudioDraft('image')).toBeNull();
  });

  test('rejects a missing entry key', () => {
    localStorage.setItem('poyo-studio-draft:image', JSON.stringify({ version: 1, values }));
    expect(readStudioDraft('image')).toBeNull();
  });

  test('rejects a missing sizeMode', () => {
    localStorage.setItem(
      'poyo-studio-draft:image',
      JSON.stringify({ version: 1, entryKey: 'seedream-5-0-pro', values })
    );
    expect(readStudioDraft('image')).toBeNull();
  });

  test('rejects an invalid sizeMode', () => {
    localStorage.setItem(
      'poyo-studio-draft:image',
      JSON.stringify({ ...draft, sizeMode: 'bogus' })
    );
    expect(readStudioDraft('image')).toBeNull();
  });

  test('rejects a PresetValues shape with missing or mistyped required fields', () => {
    const base = { version: 1, entryKey: 'seedream-5-0-pro', sizeMode: 'aspect-ratio' };
    const malformed: unknown[] = [
      { version: 1, modality: 'image', expertOverrides: [], inputRoles: [] }, // missing guided → cloneJson throws
      { ...values, guided: [] }, // guided is not a plain object
      { ...values, version: 2 }, // wrong inner PresetValues version
      { ...values, modality: 'audio' }, // invalid modality
      { ...values, inputRoles: {} }, // non-iterable inputRoles → for..of throws
      { ...values, inputRoles: [{ role: 'reference', source: 'remote', urls: 'x' }] }, // urls not array → .map throws
      { ...values, inputRoles: [{ role: 'reference', source: 'remote', urls: ['not a url'] }] }, // unparseable remote URL → new URL throws
      { ...values, inputRoles: [{ role: 'reference', source: 'remote', urls: [123] }] }, // non-string url
      { ...values, inputRoles: [{ role: 42, source: 'remote', urls: [] }] }, // non-string role
      { ...values, inputRoles: [{ role: 'reference', source: 'other', urls: [] }] }, // invalid source
      { ...values, expertOverrides: {} }, // non-array expertOverrides → .filter throws
      { ...values, expertOverrides: [{ value: 1 }] } // expertOverride missing string key
    ];
    for (const bad of malformed) {
      localStorage.setItem('poyo-studio-draft:image', JSON.stringify({ ...base, values: bad }));
      expect(readStudioDraft('image')).toBeNull();
    }
  });

  test('accepts an uploaded input role without URL-parsing its urls', () => {
    // Only remote URLs are dereferenced on restore, so an uploaded role's opaque url string is valid.
    const uploaded: PresetValues = {
      version: 1,
      modality: 'image',
      guided: {},
      expertOverrides: [{ key: 'seed', value: 7 }],
      inputRoles: [{ role: 'reference', source: 'uploaded', urls: ['local-source-token'] }]
    };
    localStorage.setItem(
      'poyo-studio-draft:image',
      JSON.stringify({
        version: 1,
        entryKey: 'seedream-5-0-pro',
        sizeMode: 'custom',
        values: uploaded
      })
    );
    expect(readStudioDraft('image')?.values).toEqual(uploaded);
  });

  test('rejects malformed JSON', () => {
    localStorage.setItem('poyo-studio-draft:image', '{not json');
    expect(readStudioDraft('image')).toBeNull();
  });

  test('ignores an oversized stored value', () => {
    localStorage.setItem('poyo-studio-draft:image', 'x'.repeat(200_001));
    expect(readStudioDraft('image')).toBeNull();
  });

  test('clears a stored draft', () => {
    writeStudioDraft('image', draft);
    clearStudioDraft('image');
    expect(readStudioDraft('image')).toBeNull();
  });
});
