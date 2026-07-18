import type { StudioEntry } from './contracts';

export interface StudioEntryGroup {
  key: string;
  provider: string;
  entries: StudioEntry[];
}

const OTHER_PROVIDER = 'Other';

function normalizedText(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function compareText(left: string, right: string): number {
  const normalizedLeft = normalizedText(left);
  const normalizedRight = normalizedText(right);
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function studioProviderLabel(entry: StudioEntry): string {
  return entry.provider?.trim() || OTHER_PROVIDER;
}

function matchesQuery(entry: StudioEntry, query: string): boolean {
  const needle = normalizedText(query);
  if (!needle) return true;
  return [entry.displayName, studioProviderLabel(entry), entry.family, entry.publicModelId]
    .join(' ')
    .toLocaleLowerCase('en-US')
    .includes(needle);
}

export function groupStudioEntries(
  entries: readonly StudioEntry[],
  favorites: readonly string[],
  query = ''
): StudioEntryGroup[] {
  const favoriteKeys = new Set(favorites);
  const groups = new Map<string, StudioEntryGroup>();

  for (const entry of entries) {
    if (!matchesQuery(entry, query)) continue;
    const provider = studioProviderLabel(entry);
    const key = normalizedText(provider);
    const group = groups.get(key);
    if (group) {
      group.entries.push(entry);
      if (compareText(provider, group.provider) < 0) group.provider = provider;
    } else {
      groups.set(key, { key, provider, entries: [entry] });
    }
  }

  const sortedGroups = [...groups.values()];
  for (const group of sortedGroups) {
    group.entries.sort((left, right) => {
      const favoriteOrder =
        Number(favoriteKeys.has(right.key)) - Number(favoriteKeys.has(left.key));
      return (
        favoriteOrder ||
        compareText(left.displayName, right.displayName) ||
        compareText(left.publicModelId, right.publicModelId) ||
        compareText(left.key, right.key)
      );
    });
  }

  return sortedGroups.sort((left, right) => {
    const otherKey = normalizedText(OTHER_PROVIDER);
    if (left.key === otherKey) return right.key === otherKey ? 0 : 1;
    if (right.key === otherKey) return -1;
    return compareText(left.provider, right.provider);
  });
}
