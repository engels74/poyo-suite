import type { PresetValues } from '../presets/types';
import type { StudioEntry, StudioRoleInput } from './contracts';
import { retainedSourceUrl, type SizeMode } from './studio-controller';
import type { AutomaticFieldKey } from './studio-sizing';

/**
 * A per-studio draft persisted to browser storage so navigating away and back — or reloading —
 * does not discard the user's setup. It reuses the preset serialization (guided values, expert
 * overrides, and safe role metadata), so it never contains secrets, local filesystem paths, local
 * filenames, or non-serializable browser `File` objects. Opaque retained-source IDs are persisted
 * because the server needs them to safely reuse a managed upload after navigation or restart.
 */
export interface StudioDraft {
  version: 3;
  entryKey: string;
  sizeMode: SizeMode;
  automaticFields: AutomaticFieldKey[];
  values: PresetValues;
  roleInputs: Record<string, StudioRoleInput[]>;
}

const MAX_BYTES = 200_000;

const SIZE_MODES: readonly SizeMode[] = ['resolution', 'aspect-ratio', 'custom'];
const AUTOMATIC_FIELDS: readonly AutomaticFieldKey[] = ['aspectRatio', 'resolution'];

function storageKey(modality: 'image' | 'video'): string {
  return `poyo-studio-draft:${modality}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isParsableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      ['http:', 'https:'].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password &&
      url.length <= 4096
    );
  } catch {
    return false;
  }
}

function optionalBoundedString(value: unknown, max: number): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= max);
}

function optionalNonNegativeNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function isValidStoredRoleInput(value: unknown): value is StudioRoleInput {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== 'string' ||
    !value.id ||
    value.id.length > 256 ||
    typeof value.role !== 'string' ||
    !value.role ||
    value.role.length > 128 ||
    (value.source !== 'remote' && value.source !== 'uploaded') ||
    typeof value.url !== 'string' ||
    !isParsableUrl(value.url) ||
    typeof value.name !== 'string' ||
    value.name.length > 256 ||
    !['image', 'video', 'audio'].includes(String(value.mediaKind)) ||
    !optionalBoundedString(value.localSourceId, 256) ||
    !optionalBoundedString(value.expiresAt, 128) ||
    !optionalNonNegativeNumber(value.sizeBytes) ||
    !optionalNonNegativeNumber(value.width) ||
    !optionalNonNegativeNumber(value.height) ||
    !optionalNonNegativeNumber(value.durationSeconds) ||
    (value.metadataProbe !== undefined &&
      value.metadataProbe !== 'measured' &&
      value.metadataProbe !== 'unavailable')
  ) {
    return false;
  }
  return value.source !== 'uploaded' || Boolean(value.localSourceId);
}

function isValidStoredRoleInputs(value: unknown): value is Record<string, StudioRoleInput[]> {
  if (!isRecord(value) || Object.keys(value).length > 32) return false;
  return Object.entries(value).every(
    ([role, inputs]) =>
      role.length > 0 &&
      role.length <= 128 &&
      Array.isArray(inputs) &&
      inputs.length <= 20 &&
      inputs.every((input) => isValidStoredRoleInput(input) && input.role === role)
  );
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
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      entryKey?: unknown;
      sizeMode?: unknown;
      automaticFields?: unknown;
      values?: unknown;
      roleInputs?: unknown;
    };
    if (
      parsed?.version !== 3 ||
      typeof parsed.entryKey !== 'string' ||
      !parsed.entryKey.trim() ||
      !SIZE_MODES.includes(parsed.sizeMode as SizeMode) ||
      !isValidPresetValues(parsed.values)
    ) {
      return null;
    }
    const automaticFields =
      Array.isArray(parsed.automaticFields) &&
      parsed.automaticFields.every((key) => AUTOMATIC_FIELDS.includes(key as AutomaticFieldKey))
        ? (parsed.automaticFields as AutomaticFieldKey[])
        : null;
    if (!automaticFields) return null;
    const roleInputs = parsed.roleInputs;
    if (!isValidStoredRoleInputs(roleInputs)) return null;
    return {
      version: 3,
      entryKey: parsed.entryKey,
      sizeMode: parsed.sizeMode as SizeMode,
      automaticFields,
      values: JSON.parse(JSON.stringify(parsed.values)) as PresetValues,
      roleInputs
    };
  } catch {
    return null;
  }
}

export function serializeStudioDraftRoleInputs(
  roleInputs: Record<string, StudioRoleInput[]>
): Record<string, StudioRoleInput[]> {
  const stored: Record<string, StudioRoleInput[]> = {};
  for (const [role, inputs] of Object.entries(roleInputs)) {
    const safe = inputs.flatMap((input) => {
      if (!isParsableUrl(input.url) || (input.source === 'uploaded' && !input.localSourceId))
        return [];
      const name =
        input.source === 'uploaded'
          ? `Uploaded ${role.replaceAll('-', ' ')}`
          : (() => {
              try {
                return new URL(input.url).hostname;
              } catch {
                return 'Remote media';
              }
            })();
      return [
        {
          id: input.localSourceId ?? input.id,
          role,
          source: input.source,
          url:
            input.source === 'uploaded' && input.localSourceId
              ? retainedSourceUrl(input.localSourceId)
              : input.url,
          name,
          mediaKind: input.mediaKind,
          ...(input.localSourceId ? { localSourceId: input.localSourceId } : {}),
          ...(input.sizeBytes === undefined ? {} : { sizeBytes: input.sizeBytes }),
          ...(input.source === 'remote' && input.expiresAt !== undefined
            ? { expiresAt: input.expiresAt }
            : {}),
          ...(input.width === undefined ? {} : { width: input.width }),
          ...(input.height === undefined ? {} : { height: input.height }),
          ...(input.durationSeconds === undefined
            ? {}
            : { durationSeconds: input.durationSeconds }),
          ...(input.metadataProbe === undefined ? {} : { metadataProbe: input.metadataProbe })
        }
      ];
    });
    if (safe.length) stored[role] = safe;
  }
  return stored;
}

export function restoreStudioDraftRoleInputs(
  entry: StudioEntry,
  draft: StudioDraft
): Record<string, StudioRoleInput[]> {
  const restored: Record<string, StudioRoleInput[]> = {};
  for (const definition of entry.inputRoles) {
    const stored = (draft.roleInputs[definition.role] ?? [])
      .filter((input) => input.mediaKind === definition.mediaKind)
      .slice(0, definition.max ?? undefined)
      .map((input) => JSON.parse(JSON.stringify(input)) as StudioRoleInput);
    if (stored.length) {
      restored[definition.role] = stored;
    }
  }
  return restored;
}

export function writeStudioDraft(modality: 'image' | 'video', draft: StudioDraft): void {
  try {
    const safeDraft = JSON.parse(JSON.stringify(draft)) as StudioDraft;
    safeDraft.values.inputRoles = safeDraft.values.inputRoles.map((input) =>
      input.source === 'uploaded' ? { ...input, urls: [] } : input
    );
    safeDraft.roleInputs = serializeStudioDraftRoleInputs(safeDraft.roleInputs);
    const serialized = JSON.stringify(safeDraft);
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
