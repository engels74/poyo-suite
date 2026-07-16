import type { PresetValues } from '../presets/types';
import type { SizeMode } from './studio-controller';

/**
 * A per-studio draft persisted to browser storage so navigating away and back — or reloading —
 * does not discard the user's setup. It reuses the preset serialization (guided values, expert
 * overrides, and input roles as remote/uploaded URLs only), so it never contains secrets, local
 * filesystem paths, or non-serializable browser `File` objects.
 */
export interface StudioDraft {
  version: 1;
  entryKey: string;
  sizeMode: SizeMode;
  values: PresetValues;
}

const MAX_BYTES = 200_000;

const SIZE_MODES: readonly SizeMode[] = ['resolution', 'aspect-ratio', 'custom'];

function storageKey(modality: 'image' | 'video'): string {
  return `poyo-studio-draft:${modality}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isParsableUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function isValidInputRole(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.role !== 'string') return false;
  if (value.source !== 'remote' && value.source !== 'uploaded') return false;
  if (!Array.isArray(value.urls)) return false;
  const remote = value.source === 'remote';
  // Remote URLs are dereferenced via `new URL(url)` during restore, so reject unparseable ones;
  // uploaded URLs are only ever echoed as strings and need no such check.
  return value.urls.every((url) => typeof url === 'string' && (!remote || isParsableUrl(url)));
}

// A hand-edited or truncated localStorage payload can pass a shallow "is an object" check yet be
// missing or mistype required PresetValues fields, which would throw during restore — e.g.
// cloneJson(guided) on an undefined `guided`, iterating a non-array `inputRoles`, or filtering a
// non-array `expertOverrides`. Validate the full shape so a corrupt draft is discarded (falls back
// to defaults) rather than breaking studio load.
function isValidPresetValues(value: unknown): value is PresetValues {
  if (!isRecord(value)) return false;
  if (value.version !== 1) return false;
  if (value.modality !== 'image' && value.modality !== 'video') return false;
  if (!isRecord(value.guided)) return false;
  if (
    !Array.isArray(value.expertOverrides) ||
    !value.expertOverrides.every(
      (override) => isRecord(override) && typeof override.key === 'string'
    )
  ) {
    return false;
  }
  return Array.isArray(value.inputRoles) && value.inputRoles.every(isValidInputRole);
}

export function readStudioDraft(modality: 'image' | 'video'): StudioDraft | null {
  try {
    const raw = localStorage.getItem(storageKey(modality));
    if (!raw || raw.length > MAX_BYTES) return null;
    const parsed = JSON.parse(raw) as Partial<StudioDraft>;
    if (
      parsed?.version !== 1 ||
      typeof parsed.entryKey !== 'string' ||
      !parsed.entryKey ||
      !SIZE_MODES.includes(parsed.sizeMode as SizeMode) ||
      !isValidPresetValues(parsed.values)
    ) {
      return null;
    }
    return parsed as StudioDraft;
  } catch {
    return null;
  }
}

export function writeStudioDraft(modality: 'image' | 'video', draft: StudioDraft): void {
  try {
    const serialized = JSON.stringify(draft);
    if (serialized.length > MAX_BYTES) return;
    localStorage.setItem(storageKey(modality), serialized);
  } catch {
    // Storage may be unavailable or full; a lost draft is a graceful, non-fatal outcome.
  }
}

export function clearStudioDraft(modality: 'image' | 'video'): void {
  try {
    localStorage.removeItem(storageKey(modality));
  } catch {
    // Ignore storage errors.
  }
}
