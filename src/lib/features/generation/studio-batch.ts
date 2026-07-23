import type { ExpertOverride } from '../registry/types';
import type { Estimate, TaskCharge } from '../pricing/contracts';
import { isPricingSignature } from '../pricing/estimate';
import type { StudioEntry, StudioJobDto, StudioOutputDto, StudioRoleInput } from './contracts';
import {
  retainedSourceUrl,
  sizeModes,
  type SizeMode,
  type StudioCreateJobRequest
} from './studio-controller';
import type { AutomaticFieldKey } from './studio-sizing';

export type StudioBatchItemState =
  | 'draft'
  | 'invalid'
  | 'submitting'
  | 'unknown'
  | 'queued'
  | 'running'
  | 'downloading'
  | 'complete'
  | 'failed';

export interface StudioBatchItem {
  id: string;
  modality: 'image' | 'video';
  displayName: string;
  sizeMode: SizeMode;
  automaticFields: AutomaticFieldKey[];
  request: StudioCreateJobRequest;
  estimate: Estimate | null;
  state: StudioBatchItemState;
  job: StudioJobDto | null;
  outputs: StudioOutputDto[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StudioBatch {
  version: 1;
  modality: 'image' | 'video';
  items: StudioBatchItem[];
}

export interface ReadyBatchEstimateSummary {
  itemCount: number;
  quantity: number;
  credits: number | null;
}

export interface SettledBatchChargeSummary {
  actionCount: number;
  credits: number;
}

interface BatchIds {
  itemId: string;
  actionId: string;
  now: string;
}

const MAX_ITEMS = 20;
const MAX_BYTES = 500_000;
const ITEM_STATES: readonly StudioBatchItemState[] = [
  'draft',
  'invalid',
  'submitting',
  'unknown',
  'queued',
  'running',
  'downloading',
  'complete',
  'failed'
];
const SIZE_MODES: readonly SizeMode[] = ['resolution', 'aspect-ratio', 'custom'];
const AUTOMATIC_FIELDS: readonly AutomaticFieldKey[] = ['aspectRatio', 'resolution'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXPERT_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const PROTECTED_EXPERT_KEY =
  /(?:model|callback|api.?key|authorization|cookie|credential|password|secret|token|path|file|directory)/i;

function storageKey(modality: 'image' | 'video'): string {
  return `poyo-studio-batch:${modality}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max = 4096): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}
function nonBlankBoundedString(value: unknown, max = 4096): value is string {
  return boundedString(value, max) && value.trim().length > 0;
}

function nullableString(value: unknown, max = 4096): boolean {
  return value === null || boundedString(value, max);
}

function nullableNumber(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isIsoTimestamp(value: unknown): value is string {
  return boundedString(value, 64) && Number.isFinite(Date.parse(value));
}

function isEstimate(value: unknown): value is Estimate {
  if (!isRecord(value)) return false;
  if (
    Object.keys(value).sort().join(',') !==
    'availability,basis,classification,credits,expiresAt,freshness,provenance,signature,sourceVerifiedAt'
  ) {
    return false;
  }
  const credits = value.credits;
  const basis = value.basis;
  const signature = value.signature;
  const available = value.availability === 'available';
  return (
    value.classification === 'estimate' &&
    (credits === null ||
      (typeof credits === 'number' &&
        Number.isFinite(credits) &&
        credits >= 0 &&
        credits <= 1_000_000_000)) &&
    (signature === null || isPricingSignature(signature)) &&
    (basis === null ||
      (isRecord(basis) &&
        Object.keys(basis).sort().join(',') === 'creditsPerUnit,unit,units' &&
        (basis.unit === 'per-output' || basis.unit === 'per-second') &&
        typeof basis.creditsPerUnit === 'number' &&
        Number.isFinite(basis.creditsPerUnit) &&
        basis.creditsPerUnit >= 0 &&
        basis.creditsPerUnit <= 1_000_000_000 &&
        typeof basis.units === 'number' &&
        Number.isFinite(basis.units) &&
        basis.units > 0 &&
        basis.units <= 100_000_000)) &&
    (value.provenance === 'published' ||
      value.provenance === 'observed' ||
      value.provenance === 'blend') &&
    (value.sourceVerifiedAt === null || isIsoTimestamp(value.sourceVerifiedAt)) &&
    (value.expiresAt === null || isIsoTimestamp(value.expiresAt)) &&
    (value.freshness === 'fresh' || value.freshness === 'stale') &&
    (available || value.availability === 'unavailable') &&
    (available
      ? credits !== null && signature !== null && basis !== null
      : credits === null && signature === null && basis === null)
  );
}

function isTaskCharge(value: unknown): value is TaskCharge {
  if (!isRecord(value)) return false;
  return (
    Object.keys(value).sort().join(',') ===
      'classification,credits,settledAt,source,terminalStatus' &&
    value.classification === 'task-charge' &&
    typeof value.credits === 'number' &&
    Number.isFinite(value.credits) &&
    value.credits >= 0 &&
    value.credits <= 1_000_000_000 &&
    value.source === 'poyo-task' &&
    (value.terminalStatus === 'finished' ||
      value.terminalStatus === 'failed' ||
      value.terminalStatus === 'cancelled') &&
    isIsoTimestamp(value.settledAt)
  );
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (depth >= 8) return false;
  if (Array.isArray(value))
    return value.length <= 100 && value.every((item) => isJsonValue(item, depth + 1));
  return (
    isRecord(value) &&
    Object.keys(value).length <= 100 &&
    Object.entries(value).every(([key, item]) => key.length <= 256 && isJsonValue(item, depth + 1))
  );
}

function isUrl(value: unknown): value is string {
  if (!boundedString(value)) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isMediaUrl(value: unknown): value is string {
  return isUrl(value) || (boundedString(value) && /^\/api\/media\/[A-Za-z0-9%._~-]+$/.test(value));
}

function isExpertOverride(value: unknown): value is ExpertOverride {
  return (
    isRecord(value) &&
    boundedString(value.key, 256) &&
    Object.keys(value).every((key) => key === 'key' || key === 'value') &&
    isJsonValue(value.value)
  );
}

function isRequestInput(value: unknown): value is StudioCreateJobRequest['inputs'][number] {
  if (!isRecord(value)) return false;
  const localSourceId = value.localSourceId;
  return (
    boundedString(value.role, 128) &&
    (value.mediaKind === 'image' || value.mediaKind === 'video') &&
    (value.source === 'remote' || value.source === 'uploaded') &&
    isUrl(value.url) &&
    (localSourceId === undefined ||
      (boundedString(localSourceId, 256) && UUID_PATTERN.test(localSourceId))) &&
    (value.source !== 'uploaded' || typeof localSourceId === 'string') &&
    (value.source !== 'remote' || localSourceId === undefined) &&
    isRecord(value.metadata) &&
    isJsonValue(value.metadata)
  );
}

function isJob(value: unknown): value is StudioJobDto {
  if (!isRecord(value)) return false;
  return (
    boundedString(value.id, 256) &&
    boundedString(value.workflow, 128) &&
    boundedString(value.publicModelId, 256) &&
    boundedString(value.localPhase, 128) &&
    boundedString(value.remoteStatus, 128) &&
    boundedString(value.failureDomain, 128) &&
    nullableString(value.attentionCode, 256) &&
    nullableString(value.poyoTaskId, 256) &&
    nullableNumber(value.progress) &&
    nullableNumber(value.estimatedCredits) &&
    nullableNumber(value.actualCredits) &&
    (value.taskCharge === undefined ||
      value.taskCharge === null ||
      isTaskCharge(value.taskCharge)) &&
    nullableString(value.lastPolledAt, 128) &&
    boundedString(value.createdAt, 128) &&
    boundedString(value.updatedAt, 128) &&
    nullableString(value.completedAt, 128)
  );
}

function isOutput(value: unknown): value is StudioOutputDto {
  if (!isRecord(value)) return false;
  return (
    boundedString(value.outputId, 256) &&
    (value.mediaKind === 'image' || value.mediaKind === 'video') &&
    (value.mediaUrl === null || isMediaUrl(value.mediaUrl)) &&
    nullableString(value.aspectRatio, 64) &&
    nullableNumber(value.pixelWidth) &&
    nullableNumber(value.pixelHeight) &&
    nullableString(value.fileName, 512) &&
    boundedString(value.downloadState, 128) &&
    typeof value.localAvailable === 'boolean'
  );
}

function isBatchItem(value: unknown, modality: 'image' | 'video'): value is StudioBatchItem {
  if (!isRecord(value) || value.modality !== modality) return false;
  if (
    !boundedString(value.id, 256) ||
    !boundedString(value.displayName, 512) ||
    !boundedString(value.createdAt, 128) ||
    !boundedString(value.updatedAt, 128) ||
    !Array.isArray(value.automaticFields) ||
    !value.automaticFields.every((key) => AUTOMATIC_FIELDS.includes(key as AutomaticFieldKey)) ||
    !SIZE_MODES.includes(value.sizeMode as SizeMode) ||
    !ITEM_STATES.includes(value.state as StudioBatchItemState) ||
    !Object.hasOwn(value, 'estimate') ||
    (value.estimate !== null && !isEstimate(value.estimate)) ||
    !Array.isArray(value.outputs) ||
    value.outputs.length > 20 ||
    !value.outputs.every(isOutput) ||
    (value.job !== null && !isJob(value.job)) ||
    (value.error !== null && typeof value.error !== 'string') ||
    !isRecord(value.request)
  )
    return false;
  const request = value.request;
  return (
    boundedString(request.actionId, 64) &&
    UUID_PATTERN.test(request.actionId) &&
    nonBlankBoundedString(request.entryKey, 256) &&
    isRecord(request.values) &&
    isJsonValue(request.values) &&
    (request.values.audioUrl === undefined || isUrl(request.values.audioUrl)) &&
    (request.values.referenceAudioUrls === undefined ||
      (Array.isArray(request.values.referenceAudioUrls) &&
        request.values.referenceAudioUrls.length <= 20 &&
        request.values.referenceAudioUrls.every(isUrl))) &&
    Array.isArray(request.expertOverrides) &&
    request.expertOverrides.length <= 100 &&
    request.expertOverrides.every(isExpertOverride) &&
    Array.isArray(request.inputs) &&
    request.inputs.length <= 20 &&
    request.inputs.every(isRequestInput)
  );
}

function safeStoredBatch(batch: StudioBatch): StudioBatch {
  const stored = clone(batch);
  for (const item of stored.items) {
    for (const input of item.request.inputs) {
      if (input.source !== 'uploaded' || !input.localSourceId) continue;
      input.url = retainedSourceUrl(input.localSourceId);
      input.metadata = {
        ...input.metadata,
        name: `Uploaded ${input.role.replaceAll('-', ' ')}`
      };
      delete input.metadata.expiresAt;
    }
  }
  return stored;
}

export function createBatchItem(
  input: Pick<
    StudioBatchItem,
    'modality' | 'displayName' | 'sizeMode' | 'automaticFields' | 'request'
  > & { estimate?: Estimate | null },
  ids: BatchIds
): StudioBatchItem {
  const request = clone(input.request);
  request.actionId = ids.actionId;
  return {
    id: ids.itemId,
    modality: input.modality,
    displayName: input.displayName,
    sizeMode: input.sizeMode,
    automaticFields: [...input.automaticFields],
    request,
    estimate: input.estimate ? clone(input.estimate) : null,
    state: 'draft',
    job: null,
    outputs: [],
    error: null,
    createdAt: ids.now,
    updatedAt: ids.now
  };
}

export function duplicateBatchItem(item: StudioBatchItem, ids: BatchIds): StudioBatchItem {
  return createBatchItem(
    {
      modality: item.modality,
      displayName: item.displayName,
      sizeMode: item.sizeMode,
      automaticFields: item.automaticFields,
      request: item.request,
      estimate: item.estimate
    },
    ids
  );
}

function normalizedBatchQuantity(item: StudioBatchItem): number {
  if (item.estimate?.basis?.unit === 'per-output') return item.estimate.basis.units;
  const quantity = item.request.values.n;
  return typeof quantity === 'number' &&
    Number.isSafeInteger(quantity) &&
    quantity > 0 &&
    quantity <= 10_000
    ? quantity
    : 1;
}

export function summarizeReadyBatchEstimates(
  items: readonly StudioBatchItem[]
): ReadyBatchEstimateSummary {
  const submittedActions = new Set(
    items
      .filter((item) => item.state !== 'draft' || item.job !== null)
      .map((item) => item.request.actionId)
  );
  const seen = new Set<string>();
  let itemCount = 0;
  let quantity = 0;
  let credits = 0;
  let unavailable = false;
  for (const item of items) {
    const actionId = item.request.actionId;
    if (
      item.state !== 'draft' ||
      item.job !== null ||
      submittedActions.has(actionId) ||
      seen.has(actionId)
    ) {
      continue;
    }
    seen.add(actionId);
    itemCount += 1;
    quantity += normalizedBatchQuantity(item);
    if (item.estimate?.availability === 'available' && item.estimate.credits !== null) {
      credits += item.estimate.credits;
    } else {
      unavailable = true;
    }
  }
  return { itemCount, quantity, credits: unavailable ? null : credits };
}

export function summarizeSettledBatchCharges(
  items: readonly StudioBatchItem[]
): SettledBatchChargeSummary {
  const actions = new Set<string>();
  let credits = 0;
  for (const item of items) {
    const charge = item.job?.taskCharge;
    const actionId = item.request.actionId;
    if (!charge || actions.has(actionId)) continue;
    actions.add(actionId);
    credits += charge.credits;
  }
  return {
    actionCount: actions.size,
    credits: Math.round(credits * 1_000_000) / 1_000_000
  };
}

export function batchStateForJob(job: StudioJobDto): StudioBatchItemState {
  if (job.remoteStatus === 'failed') return 'failed';
  if (job.localPhase === 'complete') return 'complete';
  if (job.localPhase === 'downloading') return 'downloading';
  if (job.localPhase === 'requires_attention') return 'failed';
  if (job.remoteStatus === 'running') return 'running';
  return 'queued';
}

export function applyBatchJob(item: StudioBatchItem, job: StudioJobDto): StudioBatchItem {
  if (item.job?.id === job.id) {
    const currentTime = Date.parse(item.job.updatedAt);
    const incomingTime = Date.parse(job.updatedAt);
    const currentTerminal = item.state === 'complete' || item.state === 'failed';
    const incomingState = batchStateForJob(job);
    const incomingTerminal = incomingState === 'complete' || incomingState === 'failed';
    if (
      (Number.isFinite(currentTime) &&
        Number.isFinite(incomingTime) &&
        incomingTime < currentTime) ||
      (currentTerminal && !incomingTerminal) ||
      (item.state === 'complete' && incomingState !== 'complete')
    ) {
      return item;
    }
  }
  return {
    ...item,
    state: batchStateForJob(job),
    job: clone(job),
    error: null,
    updatedAt: job.updatedAt
  };
}

export function beginPaidBatchRetry(
  item: StudioBatchItem,
  actionId: string,
  now: string
): StudioBatchItem {
  return {
    ...item,
    request: { ...item.request, actionId },
    state: 'submitting',
    job: null,
    outputs: [],
    error: null,
    updatedAt: now
  };
}

export function batchItemCompatibilityIssues(item: StudioBatchItem, entry: StudioEntry): string[] {
  const issues: string[] = [];
  if (item.request.entryKey !== entry.key || item.modality !== entry.output.mediaKind)
    return ['The saved model or media type no longer matches this batch item.'];

  const modes = sizeModes(entry);
  if (modes.length && !modes.includes(item.sizeMode))
    issues.push('The saved size mode is no longer supported.');
  const fields = new Map(entry.fields.map((field) => [field.key, field]));
  const audioValueKeys = new Set<string>(
    entry.inputRoles.flatMap((role) =>
      role.mediaKind === 'audio' && role.requestKey ? [role.requestKey] : []
    )
  );
  const hasDimensions = entry.fields.some((field) => field.kind === 'dimensions');
  for (const key of item.automaticFields) {
    if (!fields.has(key)) issues.push(`Automatic ${key} is no longer supported.`);
  }
  for (const [key, value] of Object.entries(item.request.values)) {
    const field = fields.get(key);
    if (
      !field &&
      key !== 'enableSafetyChecker' &&
      !audioValueKeys.has(key) &&
      !(hasDimensions && (key === 'width' || key === 'height'))
    ) {
      issues.push(`The saved ${key} option is no longer supported.`);
      continue;
    }
    if (field?.enum && value !== undefined && !field.enum.some((candidate) => candidate === value))
      issues.push(`The saved ${key} choice is no longer supported.`);
  }
  for (const field of entry.fields) {
    const value = item.request.values[field.key] ?? field.default;
    if (
      field.required &&
      (value === undefined || value === '' || (Array.isArray(value) && value.length === 0))
    )
      issues.push(`The ${field.key} option is now required.`);
  }
  const verifiedExpertKeys = new Set(entry.fields.map((field) => field.apiKey));
  if (entry.output.mediaKind === 'image') {
    for (const key of ['prompt', 'image_urls', 'mask_url', 'size']) verifiedExpertKeys.add(key);
  } else {
    for (const role of entry.inputRoles) {
      if (role.apiKey) verifiedExpertKeys.add(role.apiKey);
    }
    if ('fixedInput' in entry.payload)
      for (const key of Object.keys(entry.payload.fixedInput ?? {})) verifiedExpertKeys.add(key);
  }
  for (const override of item.request.expertOverrides) {
    if (
      !EXPERT_KEY_PATTERN.test(override.key) ||
      PROTECTED_EXPERT_KEY.test(override.key) ||
      verifiedExpertKeys.has(override.key)
    )
      issues.push(`The saved Expert ${override.key} override is no longer supported.`);
  }
  for (const role of entry.inputRoles) {
    const inputs = item.request.inputs.filter((input) => input.role === role.role);
    if (role.required && inputs.length < role.min)
      issues.push(`The ${role.role} input is now required.`);
    if (role.max !== null && inputs.length > role.max)
      issues.push(`The ${role.role} input now accepts fewer references.`);
  }
  for (const input of item.request.inputs) {
    const role = entry.inputRoles.find((candidate) => candidate.role === input.role);
    if (!role || role.mediaKind !== input.mediaKind)
      issues.push(`The saved ${input.role} input is no longer compatible.`);
  }
  return [...new Set(issues)];
}

export function restoreBatchItemForRegistry(
  item: StudioBatchItem,
  entry: StudioEntry | undefined
): StudioBatchItem {
  if (item.state === 'submitting')
    return {
      ...item,
      state: 'unknown',
      error:
        'The app restarted before this paid submission was confirmed. Check the saved action before retrying.'
    };
  if (item.state === 'unknown' || !['draft', 'invalid'].includes(item.state)) return item;
  if (!entry)
    return {
      ...item,
      state: 'invalid',
      error: 'This audited model is no longer available. The other batch items were kept.'
    };
  const issues = batchItemCompatibilityIssues(item, entry);
  if (!issues.length) return item;
  return {
    ...item,
    state: 'invalid',
    error: `${issues[0]} Edit this item to review current model options.`
  };
}

export function restoreBatchRoleInputs(item: StudioBatchItem): Record<string, StudioRoleInput[]> {
  const roles: Record<string, StudioRoleInput[]> = {};
  for (const [index, input] of item.request.inputs.entries()) {
    const metadata = input.metadata;
    const restored: StudioRoleInput = {
      id: input.localSourceId ?? `${item.id}-${input.role}-${index}`,
      role: input.role,
      source: input.source,
      url: input.url,
      name: typeof metadata.name === 'string' ? metadata.name : `${input.role} ${index + 1}`,
      mediaKind: input.mediaKind,
      ...(input.localSourceId ? { localSourceId: input.localSourceId } : {}),
      ...(typeof metadata.sizeBytes === 'number' ? { sizeBytes: metadata.sizeBytes } : {}),
      ...(typeof metadata.expiresAt === 'string' ? { expiresAt: metadata.expiresAt } : {}),
      ...(typeof metadata.width === 'number' ? { width: metadata.width } : {}),
      ...(typeof metadata.height === 'number' ? { height: metadata.height } : {}),
      ...(typeof metadata.durationSeconds === 'number'
        ? { durationSeconds: metadata.durationSeconds }
        : {}),
      ...(metadata.metadataProbe === 'measured' || metadata.metadataProbe === 'unavailable'
        ? { metadataProbe: metadata.metadataProbe }
        : {})
    };
    roles[input.role] = [...(roles[input.role] ?? []), restored];
  }
  const audioValues = [
    ['audio', item.request.values.audioUrl],
    ['reference-audio', item.request.values.referenceAudioUrls]
  ] as const;
  for (const [role, value] of audioValues) {
    const urls = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
    if (!urls.length || roles[role]?.length) continue;
    roles[role] = urls.map((url, index) => ({
      id: `${item.id}-${role}-${index}`,
      role,
      source: 'remote',
      url,
      name: new URL(url).hostname,
      mediaKind: 'audio'
    }));
  }
  return roles;
}

export function readStudioBatch(modality: 'image' | 'video'): StudioBatch | null {
  try {
    const raw = localStorage.getItem(storageKey(modality));
    if (!raw || raw.length > MAX_BYTES) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1 || parsed.modality !== modality) return null;
    if (!Array.isArray(parsed.items) || parsed.items.length > MAX_ITEMS) return null;
    const batch = clone(parsed as unknown as StudioBatch);
    if (!batch.items.every((item) => isBatchItem(item, modality))) return null;
    return batch;
  } catch {
    return null;
  }
}

export function writeStudioBatch(modality: 'image' | 'video', batch: StudioBatch): boolean {
  try {
    if (batch.modality !== modality || batch.items.length > MAX_ITEMS) return false;
    const safeBatch = safeStoredBatch(batch);
    if (!safeBatch.items.every((item) => isBatchItem(item, modality))) return false;
    const serialized = JSON.stringify(safeBatch);
    if (serialized.length > MAX_BYTES) return false;
    localStorage.setItem(storageKey(modality), serialized);
    return true;
  } catch {
    return false;
  }
}

export function clearStudioBatch(modality: 'image' | 'video'): void {
  try {
    localStorage.removeItem(storageKey(modality));
  } catch {
    // Browser storage is best-effort. Durable jobs remain in the server-side repository.
  }
}
