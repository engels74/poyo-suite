import type { Database } from 'bun:sqlite';
import type { StudioEntry, StudioRoleInput } from '../../features/generation/contracts';
import {
  isRetainedSourceUrl,
  valuesWithRoleInputs
} from '../../features/generation/studio-controller';
import { IMAGE_REGISTRY_ENTRIES } from '../../features/registry/image-registry';
import { normalizeRegistryRequest } from '../../features/registry/normalize-registry';
import type { ExpertOverride } from '../../features/registry/types';
import { VIDEO_REGISTRY_ENTRIES } from '../../features/registry/video-registry';
import { canonicalizeVideoSelection } from '../../features/registry/video-selection';
import type { CreateJobInput, CreateJobRequest, PublicCreateJobInput } from './types';

const actionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const allowedTopLevel = new Set(['actionId', 'entryKey', 'values', 'expertOverrides', 'inputs']);
const mediaValueKeys = new Set([
  'imageUrls',
  'maskUrl',
  'startImageUrl',
  'endImageUrl',
  'referenceImageUrls',
  'videoUrls',
  'videoUrl',
  'referenceVideoUrls',
  'referenceAudioUrls',
  'audioUrl',
  'elementImageUrls'
]);

export class JobRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = 'JobRequestError';
  }
}

export function isPaidActionId(value: unknown): value is string {
  return typeof value === 'string' && actionIdPattern.test(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new JobRequestError('invalid_job_request', `${label} must be an object.`);
  return value as Record<string, unknown>;
}

function entryFor(key: string): StudioEntry {
  const entry = [...IMAGE_REGISTRY_ENTRIES, ...VIDEO_REGISTRY_ENTRIES].find(
    (candidate) => candidate.key === key
  );
  if (entry?.status !== 'current')
    throw new JobRequestError('registry_entry_unavailable', 'Registry entry is unavailable.', 409);
  return entry;
}

function assertUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new JobRequestError('invalid_media_url', 'Media inputs require a valid URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new JobRequestError(
      'invalid_media_url',
      'Media inputs require HTTP(S) URLs without credentials.'
    );
}

function uploadNeedsRefresh(input: PublicCreateJobInput): boolean {
  if (isRetainedSourceUrl(input.url)) return true;
  const expiresAt = input.metadata?.expiresAt;
  if (typeof expiresAt !== 'string') return false;
  const expiry = Date.parse(expiresAt);
  return Number.isFinite(expiry) && expiry <= Date.now();
}

function parseExpertOverrides(value: unknown): ExpertOverride[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new JobRequestError('invalid_expert_overrides', 'Expert overrides must be a list.');
  return value.map((candidate) => {
    const override = record(candidate, 'Expert override');
    const keys = Object.keys(override);
    if (keys.some((key) => key !== 'key' && key !== 'value') || typeof override.key !== 'string')
      throw new JobRequestError('invalid_expert_override', 'Expert override is malformed.');
    return { key: override.key, value: override.value };
  });
}

function parseInputs(value: unknown): PublicCreateJobInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new JobRequestError('invalid_job_inputs', 'Job inputs must be a list.');
  const accepted = new Set(['role', 'mediaKind', 'source', 'url', 'localSourceId', 'metadata']);
  return value.map((candidate) => {
    const input = record(candidate, 'Job input');
    if (Object.keys(input).some((key) => !accepted.has(key)))
      throw new JobRequestError('unsupported_job_input_field', 'Unsupported job input field.');
    if (
      typeof input.role !== 'string' ||
      (input.mediaKind !== 'image' && input.mediaKind !== 'video') ||
      (input.source !== 'remote' && input.source !== 'uploaded') ||
      typeof input.url !== 'string'
    )
      throw new JobRequestError('invalid_job_input', 'Job input is malformed.');
    assertUrl(input.url);
    if (
      input.localSourceId !== undefined &&
      (typeof input.localSourceId !== 'string' || !input.localSourceId.trim())
    )
      throw new JobRequestError('invalid_local_source', 'Local source ID is invalid.');
    if (input.source === 'uploaded' && typeof input.localSourceId !== 'string')
      throw new JobRequestError(
        'missing_local_source',
        'Uploaded inputs require a retained local source ID.'
      );
    if (input.source === 'remote' && input.localSourceId !== undefined)
      throw new JobRequestError(
        'unexpected_local_source',
        'Remote inputs cannot claim a retained local source.'
      );
    if (
      input.metadata !== undefined &&
      (!input.metadata || typeof input.metadata !== 'object' || Array.isArray(input.metadata))
    )
      throw new JobRequestError('invalid_input_metadata', 'Input metadata must be an object.');
    return input as unknown as PublicCreateJobInput;
  });
}

function validateGuidedValues(entry: StudioEntry, value: unknown): Record<string, unknown> {
  const values = record(value, 'Guided values');
  const allowed = new Set(
    entry.fields.filter((field) => field.kind !== 'dimensions').map((field) => field.key)
  );
  if (entry.fields.some((field) => field.key === 'dimensions')) {
    allowed.add('width');
    allowed.add('height');
  }
  if (entry.output.safetyChecker) allowed.add('enableSafetyChecker');
  const allowedAudioValues = new Set<string>(
    entry.inputRoles.flatMap((role) =>
      role.mediaKind === 'audio' && role.requestKey ? [role.requestKey] : []
    )
  );
  const unsupported = Object.keys(values).find(
    (key) =>
      (!allowed.has(key) && !allowedAudioValues.has(key)) ||
      (mediaValueKeys.has(key) && !allowedAudioValues.has(key))
  );
  if (unsupported)
    throw new JobRequestError(
      'unsupported_guided_field',
      `Unsupported guided field ${unsupported}.`
    );
  return values;
}

function validateRoleInputs(entry: StudioEntry, inputs: readonly PublicCreateJobInput[]): void {
  for (const input of inputs) {
    const role = entry.inputRoles.find((candidate) => candidate.role === input.role);
    if (!role || role.mediaKind === 'audio' || role.mediaKind !== input.mediaKind)
      throw new JobRequestError(
        'incompatible_job_input',
        `Input role ${input.role} is incompatible with this workflow.`
      );
  }
  for (const role of entry.inputRoles) {
    const count = inputs.filter((input) => input.role === role.role).length;
    if (role.required && count < role.min)
      throw new JobRequestError(
        'missing_job_input',
        `Input role ${role.role} requires at least ${role.min} item.`
      );
    if (role.max !== null && count > role.max)
      throw new JobRequestError(
        'too_many_job_inputs',
        `Input role ${role.role} supports at most ${role.max} items.`
      );
  }
}

export async function prepareJobCreateRequest(
  database: Database,
  body: unknown,
  resolveManagedSource: (
    localSourceId: string,
    mediaKind: 'image' | 'video',
    refreshUpload: boolean
  ) => Promise<{ id: string; url?: string }>
): Promise<CreateJobRequest> {
  const envelope = record(body, 'Job request');
  const unsupported = Object.keys(envelope).find((key) => !allowedTopLevel.has(key));
  if (unsupported)
    throw new JobRequestError(
      'unsupported_job_request_field',
      `Unsupported job request field ${unsupported}.`
    );
  if (!isPaidActionId(envelope.actionId))
    throw new JobRequestError('invalid_action_id', 'A stable opaque action ID is required.');
  if (typeof envelope.entryKey !== 'string')
    throw new JobRequestError('invalid_entry_key', 'A registry entry is required.');

  const selection = canonicalizeVideoSelection(envelope.entryKey);
  const entry = entryFor(selection?.entryKey ?? envelope.entryKey);
  const registry = database
    .query<{ public_model_id: string; workflow: string; modality: string }, [string]>(
      "SELECT public_model_id,workflow,modality FROM registry_entries WHERE entry_key=? AND status='current' ORDER BY registry_version DESC LIMIT 1"
    )
    .get(entry.key);
  if (
    !registry ||
    registry.public_model_id !== entry.publicModelId ||
    registry.workflow !== entry.workflow ||
    registry.modality !== entry.output.mediaKind
  )
    throw new JobRequestError('registry_entry_unavailable', 'Registry entry is unavailable.', 409);

  const values = validateGuidedValues(entry, envelope.values);
  const expertOverrides = parseExpertOverrides(envelope.expertOverrides);
  const publicInputs = parseInputs(envelope.inputs);
  validateRoleInputs(entry, publicInputs);
  const inputs: CreateJobInput[] = await Promise.all(
    publicInputs.map(async (input) => {
      if (input.source !== 'uploaded' || !input.localSourceId) return input;
      const source = await resolveManagedSource(
        input.localSourceId,
        input.mediaKind,
        uploadNeedsRefresh(input)
      );
      return {
        ...input,
        ...(source.url ? { url: source.url } : {}),
        managedSourceId: source.id
      };
    })
  );
  const roleInputs = inputs.reduce<Record<string, StudioRoleInput[]>>((roles, input) => {
    const current = roles[input.role] ?? [];
    current.push({
      id: `${input.role}-${current.length}`,
      role: input.role,
      source: input.source,
      url: input.url,
      name: typeof input.metadata?.name === 'string' ? input.metadata.name : `${input.role} input`,
      mediaKind: input.mediaKind,
      ...(input.localSourceId ? { localSourceId: input.localSourceId } : {})
    });
    roles[input.role] = current;
    return roles;
  }, {});
  const guided = valuesWithRoleInputs(entry, values, roleInputs);
  const preview = normalizeRegistryRequest(entry.key, guided, expertOverrides);
  const requestedCount = values.n;
  const expectedOutputCount =
    entry.output.mediaKind === 'image' &&
    Number.isSafeInteger(requestedCount) &&
    (requestedCount as number) > 0
      ? (requestedCount as number)
      : 1;
  return {
    actionId: envelope.actionId,
    entryKey: entry.key,
    workflow: entry.workflow,
    publicModelId: entry.publicModelId,
    guidedRequest: values,
    normalizedPayload: preview.request,
    expertDiff: preview.expertDiff,
    inputs,
    expectedMediaKind: entry.output.mediaKind,
    expectedOutputCount,
    ...(typeof values.prompt === 'string' ? { prompt: values.prompt } : {})
  };
}
