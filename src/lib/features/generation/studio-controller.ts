import type { PresetValues } from '../presets/types';
import type {
  ExpertOverride,
  FieldDefinition,
  GuidedImageRequest,
  GuidedVideoRequest,
  ImageRegistryEntry,
  InputRole,
  VideoRegistryEntry
} from '../registry/types';
import type { StudioEntry, StudioRoleInput } from './contracts';

export type SizeMode = 'resolution' | 'aspect-ratio' | 'custom';

export interface StudioCreateJobRequest {
  actionId: string;
  entryKey: string;
  values: Record<string, unknown>;
  expertOverrides: ExpertOverride[];
  inputs: Array<{
    role: string;
    mediaKind: 'image' | 'video';
    source: 'remote' | 'uploaded';
    url: string;
    localSourceId?: string;
    metadata: Record<string, unknown>;
  }>;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function workflowLabel(workflow: string): string {
  const labels: Record<string, string> = {
    'text-to-image': 'Create from text',
    'image-to-image': 'Transform one image',
    'image-edit': 'Edit with references',
    'text-to-video': 'Create from text',
    'image-to-video': 'Animate an image',
    'frame-to-video': 'Use start and end frames',
    'reference-to-video': 'Create from reference media',
    'video-to-video': 'Transform a video',
    'video-edit': 'Edit a video',
    'motion-control': 'Motion control',
    'character-animation': 'Character animation',
    'character-replacement': 'Character replacement',
    'multi-shot-video': 'Multi-shot video',
    'image-fusion-video': 'Image fusion'
  };
  return labels[workflow] ?? workflow.replaceAll('-', ' ');
}

export function roleLabel(role: string): string {
  return role
    .split('-')
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}

export function initialGuidedValues(
  entry: StudioEntry,
  preset?: PresetValues
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of entry.fields) {
    if (field.default !== undefined) values[field.key] = cloneJson(field.default);
  }
  if (entry.output.safetyChecker) values.enableSafetyChecker = false;
  if (preset) Object.assign(values, cloneJson(preset.guided));
  return values;
}

export function initialRoleInputs(
  entry: StudioEntry,
  preset?: PresetValues
): Record<string, StudioRoleInput[]> {
  const roles: Record<string, StudioRoleInput[]> = {};
  for (const input of preset?.inputRoles ?? []) {
    const definition = entry.inputRoles.find((role) => role.role === input.role);
    if (!definition) continue;
    roles[input.role] = input.urls.map((url, index) => ({
      id: `${input.role}-${index}-${url}`,
      role: input.role,
      source: input.source,
      url,
      name: input.source === 'remote' ? new URL(url).hostname : `Uploaded ${roleLabel(input.role)}`,
      mediaKind: definition.mediaKind
    }));
  }
  return roles;
}

export function sizeModes(entry: StudioEntry): SizeMode[] {
  const seedreamExclusive = entry.family.startsWith('Seedream 5.0 Pro');
  const customSize = 'customSize' in entry.output && entry.output.customSize;
  if (!customSize && !seedreamExclusive) return [];
  const modes: SizeMode[] = [];
  if (
    entry.fields.some((field) => field.key === 'resolution') &&
    entry.family.startsWith('Seedream')
  )
    modes.push('resolution');
  if (entry.fields.some((field) => field.key === 'aspectRatio')) modes.push('aspect-ratio');
  if (customSize) modes.push('custom');
  return modes;
}

export function visibleFields(
  entry: StudioEntry,
  level: FieldDefinition['level'],
  sizeMode: SizeMode
): FieldDefinition[] {
  const modes = sizeModes(entry);
  return entry.fields.filter((field) => {
    if (field.level !== level) return false;
    if (!modes.length) return true;
    if (
      field.key === 'resolution' &&
      entry.family.startsWith('Seedream') &&
      sizeMode !== 'resolution'
    )
      return false;
    if (
      field.key === 'aspectRatio' &&
      modes.includes('aspect-ratio') &&
      sizeMode !== 'aspect-ratio'
    )
      return false;
    if (field.key === 'dimensions' && modes.includes('custom') && sizeMode !== 'custom')
      return false;
    return true;
  });
}

export function valuesWithRoleInputs(
  entry: StudioEntry,
  guided: Record<string, unknown>,
  roleInputs: Record<string, StudioRoleInput[]>
): GuidedImageRequest | GuidedVideoRequest {
  const values = cloneJson(guided) as Record<string, unknown>;
  for (const role of entry.inputRoles) {
    const urls = (roleInputs[role.role] ?? []).map((item) => item.url);
    if (!urls.length) continue;
    if ('requestKey' in role && role.requestKey) {
      values[role.requestKey] = role.apiKey?.endsWith('_url') ? urls[0] : urls;
    } else if (role.role === 'mask') {
      values.maskUrl = urls[0];
    } else {
      values.imageUrls = urls;
    }
  }
  return values as GuidedImageRequest | GuidedVideoRequest;
}

export function parseExpertOverrides(source: string): ExpertOverride[] {
  const trimmed = source.trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Expert overrides must be a JSON object.');
  return Object.entries(parsed as Record<string, unknown>).map(([key, value]) => ({ key, value }));
}

export function presetValues(
  modality: 'image' | 'video',
  guided: Record<string, unknown>,
  expertOverrides: ExpertOverride[],
  roleInputs: Record<string, StudioRoleInput[]>
): PresetValues {
  return {
    version: 1,
    modality,
    guided: cloneJson(guided),
    expertOverrides: cloneJson(expertOverrides),
    inputRoles: Object.entries(roleInputs)
      .filter(([, inputs]) => inputs.length)
      .map(([role, inputs]) => ({
        role,
        source: inputs.every((item) => item.source === 'remote') ? 'remote' : 'uploaded',
        urls: inputs.map((item) => item.url)
      }))
  };
}

export function createJobRequest(
  actionId: string,
  entry: StudioEntry,
  guided: Record<string, unknown>,
  expertOverrides: ExpertOverride[],
  roleInputs: Record<string, StudioRoleInput[]> = {}
): StudioCreateJobRequest {
  return {
    actionId,
    entryKey: entry.key,
    values: cloneJson(guided),
    expertOverrides: cloneJson(expertOverrides),
    inputs: Object.values(roleInputs)
      .flat()
      .filter((input): input is StudioRoleInput & { mediaKind: 'image' | 'video' } =>
        ['image', 'video'].includes(input.mediaKind)
      )
      .map((input) => ({
        role: input.role,
        mediaKind: input.mediaKind,
        source: input.source,
        url: input.url,
        ...(input.localSourceId ? { localSourceId: input.localSourceId } : {}),
        metadata: {
          name: input.name,
          ...(input.sizeBytes === undefined ? {} : { sizeBytes: input.sizeBytes }),
          ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
          ...(input.width === undefined ? {} : { width: input.width }),
          ...(input.height === undefined ? {} : { height: input.height }),
          ...(input.durationSeconds === undefined
            ? {}
            : { durationSeconds: input.durationSeconds }),
          ...(input.metadataProbe === undefined ? {} : { metadataProbe: input.metadataProbe })
        }
      }))
  };
}

export function nextMonotonicEventId(current: number, raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const next = Number(raw);
  return Number.isSafeInteger(next) && next > current ? next : null;
}

const pendingActionRecoveryDelays = [0, 150, 300, 600, 1200, 2400] as const;

export function pendingActionRecoveryDelay(attempt: number): number | null {
  return pendingActionRecoveryDelays[attempt] ?? null;
}

export function mediaAccept(role: InputRole): string {
  return role.formats
    .map((format) =>
      format.includes('/') ? format : `${role.mediaKind}/${format === 'jpg' ? 'jpeg' : format}`
    )
    .join(',');
}

export function coerceFieldValue(field: FieldDefinition, raw: string | boolean): unknown {
  if (field.kind === 'boolean') return Boolean(raw);
  if (typeof raw !== 'string') return raw;
  if (raw === '') return undefined;
  if (field.kind === 'number' || field.kind === 'integer') return Number(raw);
  if (field.kind === 'enum' && /^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

export function isImageEntry(entry: StudioEntry): entry is ImageRegistryEntry {
  return entry.output.mediaKind === 'image';
}

export function isVideoEntry(entry: StudioEntry): entry is VideoRegistryEntry {
  return entry.output.mediaKind === 'video';
}
