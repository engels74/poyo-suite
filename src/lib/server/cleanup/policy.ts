import type { LocalCleanupPolicy } from '../../features/cleanup/contracts';

export const DEFAULT_CLEANUP_POLICY: LocalCleanupPolicy = {
  mode: 'never',
  olderThanDays: null,
  maxBytes: null,
  minFreeBytes: null,
  exclusions: { favorites: true, pinned: true, tags: [] }
};

export class CleanupValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CleanupValidationError';
  }
}

function optionalPositiveInteger(value: unknown, name: string, maximum: number): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > maximum) {
    throw new CleanupValidationError(`${name} must be a positive integer.`);
  }
  return Number(value);
}

export function normalizeCleanupPolicy(value: unknown): LocalCleanupPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CleanupValidationError('A cleanup policy object is required.');
  }
  const input = value as Record<string, unknown>;
  const mode = input.mode;
  if (!['never', 'age', 'total-size', 'min-free-space'].includes(String(mode))) {
    throw new CleanupValidationError('Cleanup policy mode is not supported.');
  }
  const exclusionInput =
    input.exclusions && typeof input.exclusions === 'object' && !Array.isArray(input.exclusions)
      ? (input.exclusions as Record<string, unknown>)
      : {};
  const rawTags = exclusionInput.tags ?? [];
  if (!Array.isArray(rawTags) || rawTags.some((tag) => typeof tag !== 'string')) {
    throw new CleanupValidationError('Excluded tags must be a list of strings.');
  }
  const tags = [
    ...new Set(
      rawTags
        .map((tag) => String(tag).trim().toLocaleLowerCase())
        .filter(Boolean)
        .slice(0, 50)
    )
  ].toSorted();
  const policy: LocalCleanupPolicy = {
    mode: mode as LocalCleanupPolicy['mode'],
    olderThanDays: optionalPositiveInteger(input.olderThanDays, 'olderThanDays', 36500),
    maxBytes: optionalPositiveInteger(input.maxBytes, 'maxBytes', Number.MAX_SAFE_INTEGER),
    minFreeBytes: optionalPositiveInteger(
      input.minFreeBytes,
      'minFreeBytes',
      Number.MAX_SAFE_INTEGER
    ),
    exclusions: {
      favorites: exclusionInput.favorites !== false,
      pinned: exclusionInput.pinned !== false,
      tags
    }
  };
  if (policy.mode === 'age' && policy.olderThanDays === null)
    throw new CleanupValidationError('Age cleanup requires olderThanDays.');
  if (policy.mode === 'total-size' && policy.maxBytes === null)
    throw new CleanupValidationError('Total-size cleanup requires maxBytes.');
  if (policy.mode === 'min-free-space' && policy.minFreeBytes === null)
    throw new CleanupValidationError('Free-space cleanup requires minFreeBytes.');
  return policy;
}

export function cleanupHash(value: unknown): string {
  return new Bun.CryptoHasher('sha256').update(JSON.stringify(value)).digest('hex');
}
