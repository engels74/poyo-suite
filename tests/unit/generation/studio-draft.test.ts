import { beforeEach, describe, expect, test } from 'bun:test';
import {
  clearStudioDraft,
  readStudioDraft,
  restoreStudioDraftRoleInputs,
  type StudioDraft,
  serializeStudioDraftRoleInputs,
  writeStudioDraft
} from '../../../src/lib/features/generation/studio-draft';
import type { PresetValues } from '../../../src/lib/features/presets/types';
import { IMAGE_REGISTRY } from '../../../src/lib/features/registry/image-registry';

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
  version: 3,
  entryKey: 'seedream-5-0-pro',
  sizeMode: 'aspect-ratio',
  automaticFields: ['aspectRatio'],
  values,
  roleInputs: {
    reference: [
      {
        id: 'remote-reference',
        role: 'reference',
        source: 'remote',
        url: 'https://example.com/a.png',
        name: 'example.com',
        mediaKind: 'image'
      }
    ]
  }
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

  test('preserves stale video draft keys and sizing verbatim', () => {
    const stale: StudioDraft = {
      ...draft,
      entryKey: 'wan2.7-image-to-video:frame-to-video',
      values: {
        ...values,
        modality: 'video' as const,
        guided: { prompt: 'Animate', aspectRatio: '16:9', resolution: '720p' }
      },
      roleInputs: {},
      automaticFields: ['aspectRatio'],
      sizeMode: 'aspect-ratio' as const
    };
    localStorage.setItem('poyo-studio-draft:video', JSON.stringify(stale));
    expect(readStudioDraft('video')).toEqual(stale);
  });

  test('round-trips current WAN image-to-video and frame-to-video draft keys', () => {
    for (const entryKey of ['wan2.7-image-to-video:image-to-video', 'kling-2.6:frame-to-video']) {
      const current = {
        ...draft,
        entryKey,
        values: { ...values, modality: 'video' as const },
        roleInputs: {}
      };
      writeStudioDraft('video', current);
      expect(readStudioDraft('video')).toEqual(current);
    }
  });

  test('rejects a wrong version', () => {
    localStorage.setItem('poyo-studio-draft:image', JSON.stringify({ ...draft, version: 4 }));
    expect(readStudioDraft('image')).toBeNull();
  });

  test('rejects malformed automatic field keys', () => {
    localStorage.setItem(
      'poyo-studio-draft:image',
      JSON.stringify({ ...draft, automaticFields: ['aspectRatio', 'apiKey'] })
    );
    expect(readStudioDraft('image')).toBeNull();
  });

  test('rejects a missing entry key', () => {
    localStorage.setItem('poyo-studio-draft:image', JSON.stringify({ version: 3, values }));
    expect(readStudioDraft('image')).toBeNull();
  });

  test('rejects a whitespace-only entry key', () => {
    localStorage.setItem(
      'poyo-studio-draft:image',
      JSON.stringify({ ...draft, entryKey: ' \t\n ' })
    );
    expect(readStudioDraft('image')).toBeNull();
  });

  test('rejects a missing sizeMode', () => {
    localStorage.setItem(
      'poyo-studio-draft:image',
      JSON.stringify({ version: 3, entryKey: 'seedream-5-0-pro', values })
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
    const base = {
      version: 3,
      entryKey: 'seedream-5-0-pro',
      sizeMode: 'aspect-ratio',
      automaticFields: [],
      roleInputs: {}
    };
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
        version: 3,
        entryKey: 'seedream-5-0-pro',
        sizeMode: 'custom',
        automaticFields: [],
        values: uploaded,
        roleInputs: {}
      })
    );
    expect(readStudioDraft('image')?.values).toEqual(uploaded);
  });

  test('persists an opaque retained source and measured metadata without a local filename', () => {
    const serialized = serializeStudioDraftRoleInputs({
      reference: [
        {
          id: 'browser-file-id',
          role: 'reference',
          source: 'uploaded',
          url: 'https://uploads.example.test/source.png',
          name: '/Users/alice/secret-client/source.png',
          mediaKind: 'image',
          localSourceId: 'source-opaque-1',
          sizeBytes: 42,
          width: 900,
          height: 1601,
          metadataProbe: 'measured'
        }
      ]
    });
    expect(serialized.reference?.[0]).toMatchObject({
      id: 'source-opaque-1',
      localSourceId: 'source-opaque-1',
      url: 'https://retained-source.invalid/source-opaque-1',
      name: 'Uploaded reference',
      width: 900,
      height: 1601
    });
    expect(JSON.stringify(serialized)).not.toContain('/Users/alice');
    expect(JSON.stringify(serialized)).not.toContain('uploads.example.test');

    const uploadedDraft: StudioDraft = {
      ...draft,
      values: {
        ...values,
        inputRoles: [
          {
            role: 'reference',
            source: 'uploaded',
            urls: ['https://uploads.example.test/source.png']
          }
        ]
      },
      roleInputs: serialized
    };
    writeStudioDraft('image', uploadedDraft);
    const stored = readStudioDraft('image');
    expect(stored?.values.inputRoles[0]?.urls).toEqual([]);
    expect(stored?.roleInputs.reference?.[0]?.url).toBe(
      'https://retained-source.invalid/source-opaque-1'
    );
    expect(JSON.stringify(stored)).not.toContain('uploads.example.test');
  });

  test('restores a retained source but drops uploaded URLs without a source ID', () => {
    const entry = IMAGE_REGISTRY.entries.find(
      (candidate) => candidate.key === 'seedream-5.0-pro-edit:image-edit'
    );
    if (!entry) throw new Error('Missing Seedream edit fixture.');
    const retained: StudioDraft = {
      ...draft,
      entryKey: entry.key,
      values: {
        ...values,
        inputRoles: [
          {
            role: 'reference',
            source: 'uploaded',
            urls: ['https://uploads.example.test/source.png']
          }
        ]
      },
      roleInputs: {
        reference: [
          {
            id: 'source-opaque-1',
            role: 'reference',
            source: 'uploaded',
            url: 'https://uploads.example.test/source.png',
            name: 'Uploaded reference',
            mediaKind: 'image',
            localSourceId: 'source-opaque-1',
            width: 900,
            height: 1601,
            metadataProbe: 'measured'
          }
        ]
      }
    };
    expect(restoreStudioDraftRoleInputs(entry, retained).reference?.[0]).toMatchObject({
      localSourceId: 'source-opaque-1',
      width: 900,
      height: 1601
    });
    expect(restoreStudioDraftRoleInputs(entry, { ...retained, roleInputs: {} })).toEqual({});
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
