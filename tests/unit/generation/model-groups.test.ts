import { describe, expect, test } from 'bun:test';
import type { StudioEntry } from '../../../src/lib/features/generation/contracts';
import {
  groupStudioEntries,
  studioProviderLabel
} from '../../../src/lib/features/generation/model-groups';
import { IMAGE_REGISTRY_ENTRIES } from '../../../src/lib/features/registry/image-registry';
import type { ImageRegistryEntry } from '../../../src/lib/features/registry/types';

function firstImageModel(): ImageRegistryEntry {
  const entry = IMAGE_REGISTRY_ENTRIES[0];
  if (!entry) throw new Error('Image registry has no entries');
  return entry;
}

const baseModel = firstImageModel();

function model(
  key: string,
  provider: string,
  displayName: string,
  publicModelId = key
): StudioEntry {
  return {
    ...baseModel,
    key,
    provider,
    displayName,
    publicModelId
  };
}

describe('studio model groups', () => {
  test('groups providers case-insensitively, sorts them, and leaves Other last', () => {
    const groups = groupStudioEntries(
      [
        model('other', '  ', 'Unassigned'),
        model('zeta', 'Zeta', 'Zeta model'),
        model('acme-lower', 'acme', 'Lowercase'),
        model('acme-title', 'Acme', 'Title case')
      ],
      []
    );

    expect(groups.map((group) => group.provider)).toEqual(['Acme', 'Zeta', 'Other']);
    expect(groups[0]?.entries.map((entry) => entry.key)).toEqual(['acme-lower', 'acme-title']);
    expect(studioProviderLabel(model('blank', '', 'Blank'))).toBe('Other');
    expect(
      studioProviderLabel({
        ...model('missing', '', 'Missing'),
        provider: undefined
      } as unknown as StudioEntry)
    ).toBe('Other');
    expect(
      groupStudioEntries(
        [model('other-lower', 'other', 'Other model'), model('zeta-only', 'Zeta', 'Zeta model')],
        []
      ).map((group) => group.provider)
    ).toEqual(['Zeta', 'other']);
  });

  test('sorts favorites first, then display name, public model ID, and key', () => {
    const groups = groupStudioEntries(
      [
        model('plain-b', 'Acme', 'Beta'),
        model('favorite-z', 'Acme', 'Zulu'),
        model('same-b', 'Acme', 'Same', 'model-b'),
        model('same-a', 'Acme', 'Same', 'model-a'),
        model('favorite-a', 'Acme', 'Alpha')
      ],
      ['favorite-z', 'favorite-a']
    );

    expect(groups[0]?.entries.map((entry) => entry.key)).toEqual([
      'favorite-a',
      'favorite-z',
      'plain-b',
      'same-a',
      'same-b'
    ]);
  });

  test('filters across model, provider, family, and public ID without empty groups', () => {
    const entries = [
      model('alpha', 'Acme', 'Aurora', 'public-alpha'),
      model('beta', 'Beta Labs', 'Borealis', 'public-beta')
    ];
    const family = entries[0]?.family ?? '';

    expect(groupStudioEntries(entries, [], ' beta ').map((group) => group.provider)).toEqual([
      'Beta Labs'
    ]);
    expect(groupStudioEntries(entries, [], family)[0]?.entries[0]?.key).toBe('alpha');
    expect(groupStudioEntries(entries, [], 'PUBLIC-ALPHA')[0]?.entries[0]?.key).toBe('alpha');
    expect(groupStudioEntries(entries, [], 'missing')).toEqual([]);
  });
});
