<script lang="ts">
import { onMount, untrack } from 'svelte';
import AppIcon from '$lib/components/ui/AppIcon.svelte';
import Badge from '$lib/components/ui/Badge.svelte';
import Button from '$lib/components/ui/Button.svelte';
import LinkButton from '$lib/components/ui/LinkButton.svelte';
import Sheet from '$lib/components/ui/Sheet.svelte';
import type {
  StudioEntry,
  StudioJobDto,
  StudioLoadData,
  StudioOutputDto,
  StudioRoleInput
} from '$lib/features/generation/contracts';
import {
  type BrowserMediaMetadata,
  mediaMetadataLabel,
  probeBrowserMedia,
  validateLocalFileSelection
} from '$lib/features/generation/media-preflight';
import {
  createStudioSubmissionSnapshot,
  filterRetiredExpertOverrides,
  initialGuidedValues,
  initialRoleInputs,
  mediaAccept,
  nextMonotonicEventId,
  readPaidSubmissionResponse,
  parseExpertOverrides,
  pendingActionRecoveryDelay,
  presetValues,
  roleLabel,
  type SizeMode,
  type StudioSubmissionSnapshot,
  sizeModes,
  valuesWithRoleInputs,
  visibleFields,
  workflowLabel
} from '$lib/features/generation/studio-controller';
import {
  applyStudioJobEvent,
  compareStudioJobRecency,
  mergeKnownStudioSnapshot,
  nextStudioResultCandidate,
  upsertStudioSessionJob,
  type StudioJobEventUpdate,
  type StudioResultCandidateStates,
  type StudioSessionJobs
} from '$lib/features/generation/studio-session';
import {
  automaticFieldChoice,
  automaticSizingIssues,
  initialAutomaticFields,
  restoreAutomaticFields,
  resolvedGuidedValues,
  type AutomaticFieldKey,
  type AutomaticFieldState
} from '$lib/features/generation/studio-sizing';
import {
  clearStudioDraft,
  readStudioDraft,
  restoreStudioDraftRoleInputs,
  serializeStudioDraftRoleInputs,
  writeStudioDraft
} from '$lib/features/generation/studio-draft';
import {
  applyBatchJob,
  beginPaidBatchRetry,
  createBatchItem,
  duplicateBatchItem,
  readStudioBatch,
  restoreBatchItemForRegistry,
  restoreBatchRoleInputs,
  writeStudioBatch,
  type StudioBatch,
  type StudioBatchItem
} from '$lib/features/generation/studio-batch';
import type {
  ExpertOverride,
  FieldDefinition,
  NormalizedPreview
} from '$lib/features/registry/types';
import BatchReview from './BatchReview.svelte';
import ChoiceField from './ChoiceField.svelte';
import FieldControl from './FieldControl.svelte';
import ModelPicker from './ModelPicker.svelte';

interface Props {
  data: StudioLoadData;
}

type MobileStep = 'setup' | 'prompt' | 'inputs' | 'output' | 'review';
type UploadPhase = 'preflight' | 'local' | 'poyo' | 'complete' | 'error';

interface UploadProgressState {
  phase: UploadPhase;
  percent: number | null;
  message: string;
}

interface SourceUploadResult {
  source?: { id: string; name: string; mediaKind: 'image' | 'video'; sizeBytes: number };
  upload?: { url: string; expiresAt: string };
  error?: { message?: string };
}

let { data }: Props = $props();

const initialData = untrack(() => data);
const initialEntry =
  initialData.entries.find((entry) => entry.key === initialData.preset?.entryKey) ??
  initialData.entries.find((entry) =>
    initialData.preferences.some((item) => item.entryKey === entry.key && item.favorite)
  ) ??
  initialData.entries[0];
if (!initialEntry) throw new Error('The studio registry has no selectable workflows.');
const initialGuided = initialGuidedValues(initialEntry, initialData.preset?.values);
const initialRoles = initialRoleInputs(initialEntry, initialData.preset?.values);
const initialExpertOverrides = filterRetiredExpertOverrides(
  initialEntry,
  initialData.preset?.values.expertOverrides ?? []
);
const initialAutomatic = initialAutomaticFields(initialEntry, Boolean(initialData.preset));

function inferSizeMode(entry: StudioEntry, values: Record<string, unknown>): SizeMode {
  if (values.aspectRatio !== undefined) return 'aspect-ratio';
  if (values.width !== undefined || values.height !== undefined) return 'custom';
  return sizeModes(entry)[0] ?? 'resolution';
}

let entryKey = $state(initialEntry.key);
let guided = $state<Record<string, unknown>>(initialGuided);
let roleInputs = $state<Record<string, StudioRoleInput[]>>(initialRoles);
let sizeMode = $state<SizeMode>(inferSizeMode(initialEntry, initialGuided));
let expertText = $state(
  initialExpertOverrides.length
    ? JSON.stringify(
        Object.fromEntries(initialExpertOverrides.map((item) => [item.key, item.value])),
        null,
        2
      )
    : ''
);
let automaticFields = $state<AutomaticFieldState>(initialAutomatic);
let preview = $state<NormalizedPreview | null>(null);
let previewIssues = $state<string[]>([]);
let previewState = $state<'idle' | 'validating' | 'valid' | 'invalid'>('idle');
let previewRevision = $state(0);
let previewSequence = 0;
let dirty = $state(Boolean(initialData.preset));
let submitting = $state(false);
let submissionLocked = $state(false);
let submissionUnknown = $state(false);
let recoveryConcluded = $state(false);
let recoveryExhausted = $state(false);
let activeJob = $state<StudioJobDto | null>(null);
let sessionJobs = $state<StudioSessionJobs>({});
let resultJob = $state<StudioJobDto | null>(null);
let connection = $state<'connecting' | 'connected' | 'reconnecting'>('connecting');
let balance = $state(initialData.balance);
let balanceRefreshing = $state(false);
let favorites = $state(
  initialData.preferences.filter((item) => item.favorite).map((item) => item.entryKey)
);
let remoteDrafts = $state<Record<string, string>>({});
let uploadingRole = $state<string | null>(null);
let uploadError = $state<Record<string, string>>({});
let uploadProgress = $state<Record<string, UploadProgressState>>({});
let inspectorWidth = $state(380);
let inspectorCollapsed = $state(false);
let setupOpen = $state(false);
let mobileStep = $state<MobileStep>('setup');
let showPresetForm = $state(false);
let presetName = $state(initialData.preset?.name ?? '');
let presetDescription = $state(initialData.preset?.description ?? '');
let presetMessage = $state(initialData.preset ? `Loaded preset “${initialData.preset.name}”.` : '');
let lastEventId = -1;
let recoverySequence = 0;
let hydrated = $state(false);
// Suppress draft persistence when the session's initial state is driven by an explicit preset/job
// URL or an unresolved paid action (draft restore is skipped in that case), so the ephemeral state
// never clobbers the user's stored "last setup" draft. An explicit reset re-enables auto-save.
let draftPersistSuspended = $state(false);
let restoredMessage = $state('');
let outputs = $state<StudioOutputDto[] | null>(null);
let outputsError = $state('');
let selectedOutput = $state(0);
let outputCandidateStates = $state<StudioResultCandidateStates>({});
let loadingOutputs = $derived(Object.values(outputCandidateStates).includes('loading'));
let completedCredits = $state<number | null>(null);
let nowMs = $state(0);
let batch = $state<StudioBatch>({
  version: 1,
  modality: initialData.modality,
  items: []
});
let batchHydrated = $state(false);
let batchSubmitting = $state(false);
let editingBatchItemId = $state<string | null>(null);
const balanceStaleMs = 10 * 60_000;
let balanceStale = $derived(
  balance !== null && nowMs > 0 && nowMs - new Date(balance.fetchedAt).getTime() > balanceStaleMs
);

const pendingActionStorageKey = `poyo-studio-pending-action:${initialData.modality}`;
interface PendingAction {
  actionId: string;
  entryKey: string;
  createdAt: number;
}

function readPendingAction(): PendingAction | null {
  const raw = sessionStorage.getItem(pendingActionStorageKey);
  if (!raw || raw.length > 256) return null;
  try {
    const value = JSON.parse(raw) as Partial<PendingAction>;
    return typeof value.actionId === 'string' &&
      /^[0-9a-f-]{36}$/i.test(value.actionId) &&
      typeof value.entryKey === 'string' &&
      value.entryKey.length <= 160 &&
      typeof value.createdAt === 'number'
      ? (value as PendingAction)
      : null;
  } catch {
    return null;
  }
}

function storePendingAction(action: PendingAction): void {
  sessionStorage.setItem(pendingActionStorageKey, JSON.stringify(action));
}

function clearPendingAction(actionId?: string): void {
  const pending = readPendingAction();
  if (!actionId || pending?.actionId === actionId)
    sessionStorage.removeItem(pendingActionStorageKey);
}

let selectedEntry = $derived(data.entries.find((entry) => entry.key === entryKey) ?? initialEntry);
let workflows = $derived([...new Set(data.entries.map((entry) => entry.workflow))]);
let modelEntries = $derived(
  data.entries
    .filter((entry) => entry.workflow === selectedEntry.workflow)
    .toSorted((left, right) => {
      const favoriteDifference =
        Number(favorites.includes(right.key)) - Number(favorites.includes(left.key));
      if (favoriteDifference) return favoriteDifference;
      return left.displayName.localeCompare(right.displayName);
    })
);
let promptFields = $derived(
  visibleFields(selectedEntry, 'essential', sizeMode).filter((field) =>
    ['prompt', 'multiPrompt'].includes(field.key)
  )
);
let setupFields = $derived(
  visibleFields(selectedEntry, 'essential', sizeMode).filter(
    (field) => !['prompt', 'multiPrompt'].includes(field.key)
  )
);
let commonFields = $derived(visibleFields(selectedEntry, 'common', sizeMode));
let advancedFields = $derived(visibleFields(selectedEntry, 'advanced', sizeMode));
let availableSizeModes = $derived(sizeModes(selectedEntry));
let advancedChanged = $derived(
  advancedFields.filter(
    (field) => guided[field.key] !== undefined && guided[field.key] !== field.default
  ).length
);
let activeAutomaticFields = $derived<AutomaticFieldState>({
  aspectRatio:
    automaticFields.aspectRatio &&
    selectedEntry.fields.some((field) => field.key === 'aspectRatio') &&
    (!availableSizeModes.includes('aspect-ratio') || sizeMode === 'aspect-ratio'),
  resolution:
    automaticFields.resolution &&
    selectedEntry.fields.some((field) => field.key === 'resolution') &&
    (!availableSizeModes.includes('resolution') || sizeMode === 'resolution')
});
let resolvedGuided = $derived(
  resolvedGuidedValues(selectedEntry, guided, roleInputs, activeAutomaticFields)
);
let currentGuided = $derived(valuesWithRoleInputs(selectedEntry, resolvedGuided, roleInputs));
let hasApiKey = $derived(data.apiKey.status === 'configured');
let allRoleInputs = $derived(Object.values(roleInputs).flat());

function updateGuided(key: string, value: unknown): void {
  if (value === undefined || value === '') delete guided[key];
  else guided[key] = value;
  dirty = true;
  previewRevision += 1;
}

function isAutomaticField(
  field: FieldDefinition
): field is FieldDefinition & { key: AutomaticFieldKey } {
  return field.key === 'aspectRatio' || field.key === 'resolution';
}

function updateChoice(key: string, value: unknown, automatic: boolean): void {
  if (key !== 'aspectRatio' && key !== 'resolution') return;
  automaticFields[key] = automatic;
  if (!automatic) updateGuided(key, value);
  else {
    dirty = true;
    previewRevision += 1;
  }
}

function chooseSizeMode(next: SizeMode): void {
  sizeMode = next;
  if (next !== 'resolution' && selectedEntry.family.startsWith('Seedream'))
    delete guided.resolution;
  if (next !== 'aspect-ratio') delete guided.aspectRatio;
  if (next !== 'custom') {
    delete guided.width;
    delete guided.height;
  }
  dirty = true;
  previewRevision += 1;
}

function switchEntry(next: StudioEntry): void {
  if (next.key === entryKey) return;
  if (submissionUnknown || readPendingAction()) {
    previewIssues = [
      'Reconcile the unknown paid action before changing models or clearing this draft.'
    ];
    return;
  }
  if (dirty && !window.confirm('Change model and remove incompatible draft values and inputs?'))
    return;
  entryKey = next.key;
  guided = initialGuidedValues(next);
  automaticFields = initialAutomaticFields(next);
  roleInputs = {};
  sizeMode = inferSizeMode(next, guided);
  expertText = '';
  preview = null;
  previewIssues = [];
  editingBatchItemId = null;
  dirty = false;
  previewRevision += 1;
}

function switchWorkflow(workflow: string): void {
  const next = data.entries.find((entry) => entry.workflow === workflow);
  if (next) switchEntry(next);
}

async function requestPreview(): Promise<NormalizedPreview | null> {
  const sequence = ++previewSequence;
  previewState = 'validating';
  previewIssues = [];
  const sizingIssues = automaticSizingIssues(selectedEntry, roleInputs, activeAutomaticFields);
  if (sizingIssues.length) {
    preview = null;
    previewState = 'invalid';
    previewIssues = sizingIssues;
    return null;
  }
  try {
    const overrides = parseExpertOverrides(expertText);
    const response = await fetch('/api/requests/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entryKey, values: currentGuided, expertOverrides: overrides })
    });
    const result = (await response.json()) as
      | NormalizedPreview
      | { error: { code: string; message?: string; issues?: string[] } };
    if (sequence !== previewSequence) return null;
    if (!response.ok || 'error' in result) {
      preview = null;
      previewState = 'invalid';
      previewIssues =
        'error' in result
          ? (result.error.issues ?? [result.error.message ?? 'The request is not valid.'])
          : ['The request is not valid.'];
      return null;
    }
    preview = result;
    previewState = 'valid';
    return result;
  } catch (error) {
    if (sequence !== previewSequence) return null;
    preview = null;
    previewState = 'invalid';
    previewIssues = [
      error instanceof Error ? error.message : 'The request preview is unavailable.'
    ];
    return null;
  }
}

function captureSubmissionSnapshot(actionId: string): StudioSubmissionSnapshot | null {
  const sizingIssues = automaticSizingIssues(selectedEntry, roleInputs, activeAutomaticFields);
  if (sizingIssues.length) {
    preview = null;
    previewState = 'invalid';
    previewIssues = sizingIssues;
    return null;
  }
  try {
    return createStudioSubmissionSnapshot(
      actionId,
      selectedEntry,
      resolvedGuided,
      parseExpertOverrides(expertText),
      roleInputs
    );
  } catch (error) {
    preview = null;
    previewState = 'invalid';
    previewIssues = [error instanceof Error ? error.message : 'Expert overrides are invalid.'];
    return null;
  }
}

async function validateSubmissionSnapshot(
  snapshot: StudioSubmissionSnapshot,
  revision: number
): Promise<boolean> {
  if (revision === previewRevision) {
    previewState = 'validating';
    previewIssues = [];
  }
  try {
    const response = await fetch('/api/requests/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(snapshot.preview)
    });
    const result = (await response.json()) as
      | NormalizedPreview
      | { error: { code: string; message?: string; issues?: string[] } };
    if (!response.ok || 'error' in result) {
      if (revision === previewRevision) {
        preview = null;
        previewState = 'invalid';
        previewIssues =
          'error' in result
            ? (result.error.issues ?? [result.error.message ?? 'The request is not valid.'])
            : ['The request is not valid.'];
      }
      return false;
    }
    if (revision === previewRevision) {
      preview = result;
      previewState = 'valid';
    }
    return true;
  } catch (error) {
    if (revision === previewRevision) {
      preview = null;
      previewState = 'invalid';
      previewIssues = [
        error instanceof Error ? error.message : 'The request preview is unavailable.'
      ];
    }
    return false;
  }
}

$effect(() => {
  previewRevision;
  entryKey;
  expertText;
  const timer = window.setTimeout(() => void requestPreview(), 260);
  return () => window.clearTimeout(timer);
});

$effect(() => {
  if (!batchHydrated) return;
  writeStudioBatch(data.modality, batch);
});

// Persist a secrets-free draft so in-app navigation and reloads restore the studio setup.
// Guarded by `hydrated` so the initial default state never overwrites a stored draft before
// onMount has had a chance to restore it.
$effect(() => {
  if (!hydrated || draftPersistSuspended) return;
  let overrides: ExpertOverride[] = [];
  try {
    overrides = parseExpertOverrides(expertText);
  } catch {
    // Expert text is temporarily invalid (mid-edit): skip persisting rather than clobbering the
    // stored draft's overrides with an empty set and losing the user's work on navigation/reload.
    return;
  }
  writeStudioDraft(data.modality, {
    version: 3,
    entryKey,
    sizeMode,
    automaticFields: (['aspectRatio', 'resolution'] as const).filter((key) => automaticFields[key]),
    values: presetValues(data.modality, guided, overrides, roleInputs),
    roleInputs: serializeStudioDraftRoleInputs(roleInputs)
  });
});

function acceptSessionJob(job: StudioJobDto): StudioJobDto {
  const previous = sessionJobs[job.id];
  sessionJobs = upsertStudioSessionJob(sessionJobs, job);
  const accepted = sessionJobs[job.id] ?? job;
  retryTransientOutputAfterJobUpdate(job.id, previous, accepted);
  return accepted;
}

function retryTransientOutputAfterJobUpdate(
  jobId: string,
  previous: StudioJobDto | undefined,
  updated: StudioJobDto | undefined
): void {
  if (
    outputCandidateStates[jobId] !== 'transient' ||
    !updated ||
    previous?.updatedAt === updated.updatedAt
  )
    return;
  const nextStates = { ...outputCandidateStates };
  delete nextStates[jobId];
  outputCandidateStates = nextStates;
}

async function loadResultCandidate(job: StudioJobDto): Promise<void> {
  outputCandidateStates = { ...outputCandidateStates, [job.id]: 'loading' };
  if (!resultJob) outputsError = '';
  try {
    const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/outputs`);
    const result = (await response.json()) as {
      outputs?: StudioOutputDto[];
      actualCredits?: number | null;
    };
    if (!response.ok || !result.outputs?.some((output) => output.mediaUrl)) {
      outputCandidateStates = {
        ...outputCandidateStates,
        [job.id]: response.ok ? 'empty' : 'transient'
      };
      if (!resultJob)
        outputsError = 'The generated media could not be loaded. Open the job to review it.';
      return;
    }
    outputCandidateStates = { ...outputCandidateStates, [job.id]: 'viewable' };
    const accepted = sessionJobs[job.id] ?? job;
    if (!resultJob || compareStudioJobRecency(accepted, resultJob) > 0) {
      resultJob = accepted;
      outputs = result.outputs;
      selectedOutput = 0;
      completedCredits = result.actualCredits ?? accepted.actualCredits ?? null;
      outputsError = '';
      if (hasApiKey) void refreshBalanceSnapshot();
    }
  } catch {
    outputCandidateStates = { ...outputCandidateStates, [job.id]: 'transient' };
    if (!resultJob)
      outputsError = 'The generated media could not be loaded. Open the job to review it.';
  }
}

$effect(() => {
  const candidate = nextStudioResultCandidate(sessionJobs, outputCandidateStates);
  if (!candidate) return;
  void loadResultCandidate(candidate);
});

function addRoleInput(role: string, input: StudioRoleInput): void {
  const definition = selectedEntry.inputRoles.find((item) => item.role === role);
  if (!definition) return;
  const current = roleInputs[role] ?? [];
  if (definition.max !== null && current.length >= definition.max) {
    uploadError[role] =
      `${roleLabel(role)} supports at most ${definition.max} input${definition.max === 1 ? '' : 's'}.`;
    return;
  }
  roleInputs[role] = [...current, input];
  uploadError[role] = '';
  dirty = true;
  previewRevision += 1;
}

function addRemote(role: string): void {
  const value = remoteDrafts[role]?.trim() ?? '';
  const definition = selectedEntry.inputRoles.find((item) => item.role === role);
  if (!definition) return;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Use an HTTP(S) URL without embedded credentials.');
    addRoleInput(role, {
      id: crypto.randomUUID(),
      role,
      source: 'remote',
      url: url.toString(),
      name: url.hostname,
      mediaKind: definition.mediaKind
    });
    remoteDrafts[role] = '';
  } catch (error) {
    uploadError[role] = error instanceof Error ? error.message : 'Remote URL is invalid.';
  }
}

async function uploadFiles(role: string, files: FileList | null): Promise<void> {
  const definition = selectedEntry.inputRoles.find((item) => item.role === role);
  if (!definition || !files?.length || definition.mediaKind === 'audio') return;
  const selectedFiles = Array.from(files);
  const selectionIssues = validateLocalFileSelection(
    definition,
    (roleInputs[role] ?? []).length,
    selectedFiles
  );
  if (selectionIssues.length) {
    uploadError[role] = selectionIssues.join(' ');
    uploadProgress[role] = { phase: 'error', percent: null, message: 'Local preflight failed.' };
    return;
  }
  uploadingRole = role;
  uploadError[role] = '';
  uploadProgress[role] = {
    phase: 'preflight',
    percent: null,
    message: 'Measuring dimensions and duration in this browser…'
  };
  const totalBytes = selectedFiles.reduce((total, file) => total + file.size, 0);
  let completedBytes = 0;
  try {
    for (const [index, file] of selectedFiles.entries()) {
      const metadata = await probeBrowserMedia(file, definition.mediaKind);
      const form = new FormData();
      form.append('file', file);
      form.append('mediaKind', definition.mediaKind);
      const response = await uploadLocalSource(
        form,
        (loaded, requestTotal) => {
          const fileFraction = requestTotal > 0 ? Math.min(1, loaded / requestTotal) : 0;
          const transferred = completedBytes + file.size * fileFraction;
          const percent = totalBytes > 0 ? Math.round((transferred / totalBytes) * 100) : null;
          uploadProgress[role] = {
            phase: 'local',
            percent,
            message: `Sending file ${index + 1} of ${selectedFiles.length} to the local server.`
          };
        },
        () => {
          const percent =
            totalBytes > 0 ? Math.round(((completedBytes + file.size) / totalBytes) * 100) : null;
          uploadProgress[role] = {
            phase: 'poyo',
            percent,
            message:
              'Local transfer complete. The server is validating and uploading to Poyo without byte-level progress.'
          };
        }
      );
      const result = response.body;
      if (response.status < 200 || response.status >= 300 || !result.source || !result.upload)
        throw new Error(result.error?.message ?? 'Local source upload failed.');
      addRoleInput(role, {
        id: result.source.id,
        role,
        source: 'uploaded',
        url: result.upload.url,
        localSourceId: result.source.id,
        name: result.source.name,
        mediaKind: result.source.mediaKind,
        sizeBytes: result.source.sizeBytes,
        expiresAt: result.upload.expiresAt,
        ...(metadata
          ? {
              width: metadata.width,
              height: metadata.height,
              ...(metadata.durationSeconds === undefined
                ? {}
                : { durationSeconds: metadata.durationSeconds }),
              metadataProbe: 'measured' as const
            }
          : { metadataProbe: 'unavailable' as const })
      });
      applyObservedDuration(role, metadata);
      completedBytes += file.size;
    }
    uploadProgress[role] = {
      phase: 'complete',
      percent: 100,
      message: 'Local transfer and Poyo upload completed.'
    };
  } catch (error) {
    uploadError[role] = error instanceof Error ? error.message : 'Local source upload failed.';
    uploadProgress[role] = { phase: 'error', percent: null, message: 'Upload stopped.' };
  } finally {
    uploadingRole = null;
  }
}

function uploadLocalSource(
  form: FormData,
  onProgress: (loaded: number, total: number) => void,
  onLocalComplete: () => void
): Promise<{ status: number; body: SourceUploadResult }> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/sources');
    request.responseType = 'json';
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    };
    request.upload.onload = onLocalComplete;
    request.onerror = () =>
      reject(new Error('The browser could not reach the local upload route.'));
    request.onabort = () => reject(new Error('The local upload was cancelled.'));
    request.onload = () => {
      const body =
        request.response && typeof request.response === 'object'
          ? (request.response as SourceUploadResult)
          : ({} as SourceUploadResult);
      resolve({ status: request.status, body });
    };
    request.send(form);
  });
}

function observedDurationField(role: string): string | null {
  return role === 'source-video'
    ? 'sourceVideoDuration'
    : role === 'reference-video'
      ? 'referenceVideoDuration'
      : null;
}

function applyObservedDuration(role: string, metadata: BrowserMediaMetadata | null): void {
  if (metadata?.durationSeconds === undefined) return;
  const fieldKey = observedDurationField(role);
  if (!fieldKey) return;
  const field = selectedEntry.fields.find((candidate) => candidate.key === fieldKey);
  if (!field) return;
  const observed =
    field.kind === 'integer'
      ? Math.ceil(metadata.durationSeconds)
      : Number(metadata.durationSeconds.toFixed(3));
  updateGuided(fieldKey, observed);
}

function removeRoleInput(role: string, id: string): void {
  const remaining = (roleInputs[role] ?? []).filter((item) => item.id !== id);
  roleInputs[role] = remaining;
  if (!remaining.length) {
    const fieldKey = observedDurationField(role);
    if (fieldKey) delete guided[fieldKey];
  }
  dirty = true;
  previewRevision += 1;
}

async function toggleFavorite(): Promise<void> {
  const favorite = !favorites.includes(entryKey);
  if (favorite) favorites = [...favorites, entryKey];
  else favorites = favorites.filter((key) => key !== entryKey);
  await fetch('/api/model-preferences', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entryKey, favorite })
  }).catch(() => undefined);
}

async function refreshBalanceSnapshot(): Promise<void> {
  balanceRefreshing = true;
  try {
    const response = await fetch('/api/account/balance', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    const result = (await response.json()) as { balance?: StudioLoadData['balance'] };
    if (response.ok && result.balance) balance = result.balance;
    nowMs = Date.now();
  } catch {
    // Balance refresh is best-effort: a network failure or a non-JSON/empty error body must not
    // reject. Call sites use `void refreshBalanceSnapshot()` and the refresh button handler, where a
    // rejection would go unhandled — keep the last known balance and let a later action retry.
  } finally {
    balanceRefreshing = false;
  }
}

async function submit(): Promise<void> {
  if (submitting || submissionLocked || !hasApiKey) return;
  const action: PendingAction = {
    actionId: crypto.randomUUID(),
    entryKey,
    createdAt: Date.now()
  };
  const revision = previewRevision;
  const snapshot = captureSubmissionSnapshot(action.actionId);
  if (!snapshot) return;
  submitting = true;
  if (!(await validateSubmissionSnapshot(snapshot, revision))) {
    submitting = false;
    return;
  }
  storePendingAction(action);
  try {
    const response = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(snapshot.request)
    });
    const { outcome, result } = await readPaidSubmissionResponse<StudioJobDto>(response);
    if (outcome === 'rejected') {
      clearPendingAction(action.actionId);
      submissionUnknown = false;
      submissionLocked = false;
      previewIssues = [result.error?.message ?? 'The local server rejected the request.'];
      return;
    }
    if (outcome === 'ambiguous' || !result.job) {
      submissionUnknown = true;
      submissionLocked = true;
      previewIssues = [
        'The local server response did not confirm the paid job. The action remains locked until reconciliation.'
      ];
      void reconcilePendingAction();
      return;
    }
    clearPendingAction(action.actionId);
    activeJob = acceptSessionJob(result.job);
    submissionUnknown = false;
    submissionLocked = false;
    if (revision === previewRevision) dirty = false;
    void fetch('/api/model-preferences', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entryKey: snapshot.request.entryKey, used: true })
    });
  } catch {
    submissionUnknown = true;
    submissionLocked = true;
    previewIssues = [
      'The local server did not confirm the paid submission outcome. Automatic resubmission is blocked to avoid duplicate spend.'
    ];
    void reconcilePendingAction();
  } finally {
    submitting = false;
  }
}

function automaticFieldKeys(): AutomaticFieldKey[] {
  return (['aspectRatio', 'resolution'] as const).filter((key) => automaticFields[key]);
}

function replaceBatchItem(next: StudioBatchItem): void {
  batch.items = batch.items.map((item) => (item.id === next.id ? next : item));
}

function persistBatchNow(): void {
  if (batchHydrated) writeStudioBatch(data.modality, batch);
}

async function addCurrentToBatch(): Promise<void> {
  const incompatible = batch.items.find((item) => item.request.entryKey !== entryKey);
  if (incompatible) {
    previewIssues = [
      `This batch uses ${incompatible.displayName}. Remove its items before starting a batch with ${selectedEntry.displayName}.`
    ];
    return;
  }
  if (batch.items.length >= 20) {
    previewIssues = ['A local batch supports at most 20 independently recoverable items.'];
    return;
  }
  const existing = editingBatchItemId
    ? batch.items.find((item) => item.id === editingBatchItemId)
    : undefined;
  const now = new Date().toISOString();
  const actionId = existing?.request.actionId ?? crypto.randomUUID();
  const revision = previewRevision;
  const snapshot = captureSubmissionSnapshot(actionId);
  if (!snapshot) return;
  const batchSnapshot = {
    displayName: selectedEntry.displayName,
    sizeMode,
    automaticFields: [...automaticFieldKeys()],
    request: snapshot.request
  };
  if (!(await validateSubmissionSnapshot(snapshot, revision))) return;
  const item = createBatchItem(
    {
      modality: data.modality,
      ...batchSnapshot
    },
    {
      itemId: existing?.id ?? crypto.randomUUID(),
      actionId,
      now
    }
  );
  if (existing) {
    replaceBatchItem({ ...item, createdAt: existing.createdAt });
    editingBatchItemId = null;
    restoredMessage = 'Updated the batch item. Review the batch before submission.';
  } else {
    batch.items = [...batch.items, item];
    restoredMessage = `Added item ${batch.items.length} to the local batch.`;
  }
}

function editBatchItem(item: StudioBatchItem): void {
  if (item.state !== 'draft' && item.state !== 'invalid') return;
  const entry = data.entries.find((candidate) => candidate.key === item.request.entryKey);
  if (!entry) {
    replaceBatchItem({
      ...item,
      state: 'invalid',
      error:
        'This audited model is no longer available. Remove or duplicate the item with a current model.'
    });
    return;
  }
  if (dirty && !window.confirm('Load this batch item and replace the current setup draft?')) return;
  entryKey = entry.key;
  guided = JSON.parse(JSON.stringify(item.request.values)) as Record<string, unknown>;
  roleInputs = restoreBatchRoleInputs(item);
  automaticFields = restoreAutomaticFields(entry, item.automaticFields);
  sizeMode = sizeModes(entry).includes(item.sizeMode)
    ? item.sizeMode
    : inferSizeMode(entry, guided);
  expertText = item.request.expertOverrides.length
    ? JSON.stringify(
        Object.fromEntries(
          item.request.expertOverrides.map((override) => [override.key, override.value])
        ),
        null,
        2
      )
    : '';
  editingBatchItemId = item.id;
  dirty = true;
  restoredMessage = 'Editing a batch item. Save it back to the batch when ready.';
  previewRevision += 1;
}

function duplicateBatch(item: StudioBatchItem): void {
  if (batch.items.length >= 20) return;
  batch.items = [
    ...batch.items,
    duplicateBatchItem(item, {
      itemId: crypto.randomUUID(),
      actionId: crypto.randomUUID(),
      now: new Date().toISOString()
    })
  ];
}

function removeBatchItem(item: StudioBatchItem): void {
  if (item.state === 'unknown' || item.state === 'submitting') return;
  batch.items = batch.items.filter((candidate) => candidate.id !== item.id);
  if (editingBatchItemId === item.id) editingBatchItemId = null;
}

async function loadBatchOutputs(itemId: string, jobId: string): Promise<void> {
  const current = batch.items.find((item) => item.id === itemId);
  if (!current || current.outputs.length) return;
  try {
    const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/outputs`);
    const result = (await response.json()) as { outputs?: StudioOutputDto[] };
    const latest = batch.items.find((item) => item.id === itemId);
    if (!response.ok || !result.outputs || !latest || latest.job?.id !== jobId) return;
    replaceBatchItem({ ...latest, outputs: result.outputs });
  } catch {
    // The job remains durable and its result can be recovered from job history or a later snapshot.
  }
}

function applyJobToBatchItem(item: StudioBatchItem, job: StudioJobDto): void {
  const latest = batch.items.find((candidate) => candidate.id === item.id) ?? item;
  const accepted = acceptSessionJob(job);
  const next = applyBatchJob(latest, accepted);
  replaceBatchItem(next);
  if (next.state === 'complete') void loadBatchOutputs(next.id, accepted.id);
}

async function reconcileBatchItem(item: StudioBatchItem): Promise<boolean> {
  try {
    const response = await fetch(`/api/jobs?actionId=${encodeURIComponent(item.request.actionId)}`);
    if (response.status === 404) {
      if (item.state === 'unknown') {
        replaceBatchItem({
          ...item,
          error:
            'No local job is recorded yet. The paid action stays locked; check again before taking any retry risk.'
        });
      }
      return false;
    }
    const result = (await response.json()) as { job?: StudioJobDto };
    if (!response.ok || !result.job) return false;
    applyJobToBatchItem(item, result.job);
    return true;
  } catch {
    if (item.state === 'unknown') {
      replaceBatchItem({
        ...item,
        error: 'The local job database could not be reached. This action remains locked.'
      });
    }
    return false;
  }
}

async function submitBatchItem(itemId: string): Promise<void> {
  const item = batch.items.find((candidate) => candidate.id === itemId);
  if (item?.state !== 'draft') return;
  replaceBatchItem({ ...item, state: 'submitting', error: null });
  persistBatchNow();
  try {
    const response = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(item.request)
    });
    const { outcome, result } = await readPaidSubmissionResponse<StudioJobDto>(response);
    const latest = batch.items.find((candidate) => candidate.id === itemId) ?? item;
    if (outcome === 'rejected') {
      replaceBatchItem({
        ...latest,
        state: 'failed',
        error:
          result.error?.message ?? 'The local server rejected this item before a job was confirmed.'
      });
      return;
    }
    if (outcome === 'ambiguous' || !result.job) {
      if (await reconcileBatchItem(latest)) return;
      const unknown = {
        ...latest,
        state: 'unknown' as const,
        error:
          'The local server response did not confirm the paid job. This action is locked until it can be reconciled.'
      };
      replaceBatchItem(unknown);
      persistBatchNow();
      return;
    }
    applyJobToBatchItem(latest, result.job);
  } catch {
    const latest = batch.items.find((candidate) => candidate.id === itemId) ?? item;
    const unknown = {
      ...latest,
      state: 'unknown' as const,
      error:
        'The paid submission outcome is unknown. Automatic resubmission is blocked to avoid duplicate spend.'
    };
    replaceBatchItem(unknown);
    persistBatchNow();
    void reconcileBatchItem(unknown);
  }
}

async function submitBatch(): Promise<void> {
  if (batchSubmitting || !hasApiKey) return;
  batchSubmitting = true;
  try {
    const ready = batch.items.filter((item) => item.state === 'draft').map((item) => item.id);
    for (const itemId of ready) await submitBatchItem(itemId);
  } finally {
    batchSubmitting = false;
  }
}

async function retryBatchItem(item: StudioBatchItem): Promise<void> {
  if (item.state !== 'failed') return;
  if (!item.job) {
    const actionId = crypto.randomUUID();
    const retry = {
      ...item,
      request: { ...item.request, actionId },
      state: 'draft' as const,
      error: null,
      updatedAt: new Date().toISOString()
    };
    replaceBatchItem(retry);
    await submitBatchItem(retry.id);
    return;
  }
  if (item.job.failureDomain === 'download') {
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(item.job.id)}/outputs`);
      const result = (await response.json()) as { outputs?: StudioOutputDto[] };
      if (!response.ok || !Array.isArray(result.outputs))
        throw new Error('The local outputs could not be checked.');
      const pending = (result.outputs ?? []).filter((output) => !output.localAvailable);
      if (!pending.length) {
        replaceBatchItem({
          ...item,
          error: 'No unavailable output is currently eligible for a local download retry.'
        });
        return;
      }
      let accepted = 0;
      for (const output of pending) {
        const retryResponse = await fetch(
          `/api/jobs/${encodeURIComponent(item.job.id)}/outputs/${encodeURIComponent(output.outputId)}/retry`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}'
          }
        );
        if (retryResponse.ok) accepted += 1;
      }
      if (!accepted) throw new Error('No local download retry was accepted.');
      replaceBatchItem({
        ...item,
        state: 'downloading',
        error:
          accepted === pending.length
            ? null
            : `${accepted} of ${pending.length} local download retries were accepted.`
      });
    } catch {
      replaceBatchItem({ ...item, error: 'The local download retry could not be started.' });
    }
    return;
  }
  const ambiguous = item.job.attentionCode === 'submission_unknown';
  if (
    !window.confirm(
      ambiguous
        ? 'Poyo may already have accepted this item. Retrying can spend credits twice. Continue with a linked paid retry?'
        : 'Retrying creates a new paid Poyo job for this item. Continue?'
    )
  )
    return;
  const actionId = crypto.randomUUID();
  const retry = beginPaidBatchRetry(item, actionId, new Date().toISOString());
  replaceBatchItem(retry);
  persistBatchNow();
  try {
    const response = await fetch(
      `/api/jobs/${encodeURIComponent(item.job.id)}/${ambiguous ? 'retry-ambiguous' : 'rerun'}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          ambiguous
            ? { acknowledgeDuplicateSpendRisk: true, actionId }
            : { acknowledgeNewPaidJob: true, actionId }
        )
      }
    );
    const { outcome, result } = await readPaidSubmissionResponse<StudioJobDto>(response);
    const latest = batch.items.find((candidate) => candidate.id === item.id) ?? retry;
    if (outcome === 'rejected') {
      replaceBatchItem({
        ...latest,
        state: 'failed',
        job: item.job,
        outputs: item.outputs,
        error: result.error?.message ?? 'The local server rejected this paid retry.'
      });
      return;
    }
    if (outcome === 'ambiguous' || !result.job) {
      if (await reconcileBatchItem(latest)) return;
      const unknown = {
        ...latest,
        state: 'unknown' as const,
        error:
          'The local server response did not confirm the paid retry. Another retry is locked until this action is reconciled.'
      };
      replaceBatchItem(unknown);
      persistBatchNow();
      return;
    }
    applyJobToBatchItem(latest, result.job);
  } catch {
    const latest = batch.items.find((candidate) => candidate.id === item.id) ?? retry;
    const unknown = {
      ...latest,
      state: 'unknown' as const,
      error:
        'The paid retry outcome is unknown. Another retry is locked until this action is reconciled.'
    };
    replaceBatchItem(unknown);
    persistBatchNow();
    void reconcileBatchItem(unknown);
  }
}

function abandonBatchItem(item: StudioBatchItem): void {
  if (
    item.state !== 'unknown' ||
    !window.confirm(
      'The original request may still create a paid Poyo task. Abandon this action and accept the risk that a later retry could spend credits twice?'
    )
  )
    return;
  replaceBatchItem({
    ...item,
    state: 'failed',
    error: 'This unresolved action was explicitly abandoned. A retry will use a new paid action ID.'
  });
  persistBatchNow();
}

function resetDraft(): void {
  if (submissionUnknown || readPendingAction()) {
    previewIssues = [
      'Reset is blocked until the unknown paid action is reconciled with the local job database.'
    ];
    return;
  }
  guided = initialGuidedValues(selectedEntry);
  automaticFields = initialAutomaticFields(selectedEntry);
  roleInputs = {};
  expertText = '';
  preview = null;
  previewIssues = [];
  editingBatchItemId = null;
  submissionUnknown = false;
  submissionLocked = false;
  dirty = false;
  sizeMode = inferSizeMode(selectedEntry, guided);
  restoredMessage = '';
  clearStudioDraft(data.modality);
  // A deliberate reset returns to the normal studio entry point, so allow auto-save to resume.
  draftPersistSuspended = false;
  previewRevision += 1;
}

function dismissResultPreview(): void {
  resultJob = null;
  outputs = null;
  outputsError = '';
  completedCredits = null;
  selectedOutput = 0;
}

async function savePreset(): Promise<void> {
  presetMessage = '';
  try {
    const overrides = filterRetiredExpertOverrides(selectedEntry, parseExpertOverrides(expertText));
    const response = await fetch('/api/presets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entryKey,
        name: presetName,
        description: presetDescription,
        values: presetValues(data.modality, resolvedGuided, overrides, roleInputs)
      })
    });
    const result = (await response.json()) as {
      preset?: { name: string };
      error?: { message?: string };
    };
    if (!response.ok || !result.preset)
      throw new Error(result.error?.message ?? 'Preset could not be saved.');
    presetMessage = `Saved preset “${result.preset.name}”.`;
    showPresetForm = false;
  } catch (error) {
    presetMessage = error instanceof Error ? error.message : 'Preset could not be saved.';
  }
}

function resizeWithKeyboard(event: KeyboardEvent): void {
  const step = event.shiftKey ? 48 : 16;
  if (event.key === 'ArrowLeft') inspectorWidth = Math.min(480, inspectorWidth + step);
  else if (event.key === 'ArrowRight') inspectorWidth = Math.max(320, inspectorWidth - step);
  else if (event.key === 'Home') inspectorWidth = 320;
  else if (event.key === 'End') inspectorWidth = 480;
  else return;
  event.preventDefault();
}

function startResize(event: PointerEvent): void {
  const startX = event.clientX;
  const startWidth = inspectorWidth;
  const move = (next: PointerEvent): void => {
    inspectorWidth = Math.max(320, Math.min(480, startWidth + startX - next.clientX));
  };
  const stop = (): void => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', stop);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', stop, { once: true });
}

function updateFromJobEvent(event: MessageEvent<string>): void {
  const update = JSON.parse(event.data) as StudioJobEventUpdate;
  const batchItem = batch.items.find((item) => item.job?.id === update.jobId);
  if (batchItem?.job) {
    applyJobToBatchItem(batchItem, {
      ...batchItem.job,
      localPhase: update.localPhase,
      remoteStatus: update.remoteStatus,
      failureDomain: update.failureDomain,
      progress: update.progress,
      updatedAt: update.observedAt
    });
  }
  const previousJob = sessionJobs[update.jobId];
  sessionJobs = applyStudioJobEvent(sessionJobs, update);
  const updatedJob = sessionJobs[update.jobId];
  retryTransientOutputAfterJobUpdate(update.jobId, previousJob, updatedJob);
  if (activeJob?.id === update.jobId && updatedJob) activeJob = updatedJob;
}

function acceptDurableEvent(event: MessageEvent<string>): boolean {
  const next = nextMonotonicEventId(lastEventId, event.lastEventId);
  if (next === null) return false;
  lastEventId = next;
  return true;
}

async function reconcilePendingAction(): Promise<void> {
  const pending = readPendingAction();
  if (!pending) return;
  const sequence = ++recoverySequence;
  submissionLocked = true;
  submissionUnknown = true;
  recoveryConcluded = false;
  recoveryExhausted = false;
  let onlyNotFound = true;
  for (let attempt = 0; ; attempt += 1) {
    const delay = pendingActionRecoveryDelay(attempt);
    if (delay === null) {
      if (sequence !== recoverySequence) return;
      recoveryExhausted = true;
      recoveryConcluded = onlyNotFound;
      previewIssues = [
        onlyNotFound
          ? 'No local job appeared after repeated checks. The action remains locked until you check again or explicitly acknowledge the risk of abandoning it.'
          : 'The local job database could not yet confirm this paid action. Reset and resubmission remain blocked.'
      ];
      return;
    }
    if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay));
    if (sequence !== recoverySequence || readPendingAction()?.actionId !== pending.actionId) return;
    try {
      const response = await fetch(`/api/jobs?actionId=${encodeURIComponent(pending.actionId)}`);
      if (response.status === 404) continue;
      onlyNotFound = false;
      const result = (await response.json()) as { job?: StudioJobDto };
      if (!response.ok || !result.job) continue;
      activeJob = acceptSessionJob(result.job);
      entryKey = pending.entryKey;
      submissionUnknown = false;
      recoveryConcluded = false;
      recoveryExhausted = false;
      submissionLocked = false;
      previewIssues = [];
      clearPendingAction(pending.actionId);
      return;
    } catch {
      onlyNotFound = false;
    }
  }
}

function abandonPendingAction(): void {
  const pending = readPendingAction();
  if (!pending || !recoveryConcluded) return;
  if (
    !window.confirm(
      'The original request may still create a paid Poyo task. Abandon this action and accept the risk that a new action could spend credits twice?'
    )
  )
    return;
  recoverySequence += 1;
  clearPendingAction(pending.actionId);
  submissionUnknown = false;
  submissionLocked = false;
  recoveryConcluded = false;
  recoveryExhausted = false;
  previewIssues = [
    'The unresolved action was explicitly abandoned. Review the request before creating a new paid action.'
  ];
}

onMount(() => {
  const storedBatch = readStudioBatch(data.modality);
  if (storedBatch) {
    batch = {
      ...storedBatch,
      items: storedBatch.items.map((item) =>
        restoreBatchItemForRegistry(
          item,
          data.entries.find((candidate) => candidate.key === item.request.entryKey)
        )
      )
    };
  }
  batchHydrated = true;
  for (const item of batch.items) {
    if (item.state !== 'draft' && item.state !== 'invalid') void reconcileBatchItem(item);
  }
  // Restore the last studio draft unless an explicit preset/job URL or an unresolved paid
  // action is driving the initial state. Preserve only what is still valid for the model.
  const explicitContext = Boolean(initialData.preset) || Boolean(readPendingAction());
  if (!explicitContext) {
    const draft = readStudioDraft(data.modality);
    if (draft) {
      const entry = data.entries.find((item) => item.key === draft.entryKey);
      if (entry) {
        entryKey = entry.key;
        guided = initialGuidedValues(entry, draft.values);
        automaticFields = restoreAutomaticFields(entry, draft.automaticFields);
        roleInputs = restoreStudioDraftRoleInputs(entry, draft);
        const overrides = filterRetiredExpertOverrides(entry, draft.values.expertOverrides ?? []);
        expertText = overrides.length
          ? JSON.stringify(
              Object.fromEntries(overrides.map((item) => [item.key, item.value])),
              null,
              2
            )
          : '';
        sizeMode = sizeModes(entry).includes(draft.sizeMode)
          ? draft.sizeMode
          : inferSizeMode(entry, guided);
        // Treat the restored draft as the baseline, not an unsaved edit, so switching model
        // afterwards does not prompt to discard "changes" the user did not just make.
        previewRevision += 1;
        const adjustedAutomatic = draft.automaticFields.some(
          (key) => !entry.fields.some((field) => field.key === key)
        );
        restoredMessage = `${
          Object.keys(roleInputs).length
            ? 'Restored your last setup. Retained local sources are securely re-uploaded when needed.'
            : 'Restored your last setup.'
        }${adjustedAutomatic ? ' An automatic size preference was removed because this model no longer supports that field.' : ''}`;
      } else {
        clearStudioDraft(data.modality);
        restoredMessage = 'Your last model is unavailable, so the studio reset to defaults.';
      }
    }
  } else {
    // Draft restore was skipped because a preset/job URL or unresolved paid action drives the
    // initial state; suppress draft persist too so the ephemeral state does not clobber the user's
    // stored "last setup" draft. An explicit reset re-enables auto-save.
    draftPersistSuspended = true;
  }
  hydrated = true;
  // Balance freshness: refresh once if it is missing or stale, then tick a clock so the "stale"
  // indicator stays live without hammering the upstream balance endpoint.
  nowMs = Date.now();
  if (hasApiKey && (!balance || nowMs - new Date(balance.fetchedAt).getTime() > balanceStaleMs)) {
    void refreshBalanceSnapshot();
  }
  const balanceTick = window.setInterval(() => (nowMs = Date.now()), 60_000);
  void reconcilePendingAction();
  const events = new EventSource('/api/events/jobs');
  events.onopen = () => (connection = 'connected');
  events.onerror = () => (connection = 'reconnecting');
  events.addEventListener('snapshot', (event) => {
    const message = event as MessageEvent<string>;
    if (!acceptDurableEvent(message)) return;
    connection = 'connected';
    const snapshot = JSON.parse(message.data) as { jobs: StudioJobDto[] };
    for (const item of batch.items) {
      const matchingBatchJob = snapshot.jobs.find((job) => job.id === item.job?.id);
      if (matchingBatchJob) applyJobToBatchItem(item, matchingBatchJob);
    }
    const previousJobs = sessionJobs;
    sessionJobs = mergeKnownStudioSnapshot(sessionJobs, snapshot.jobs);
    for (const job of snapshot.jobs)
      retryTransientOutputAfterJobUpdate(job.id, previousJobs[job.id], sessionJobs[job.id]);
    const matching = activeJob ? snapshot.jobs.find((job) => job.id === activeJob?.id) : undefined;
    if (matching) activeJob = sessionJobs[matching.id] ?? activeJob;
  });
  events.addEventListener('job', (event) => {
    const message = event as MessageEvent<string>;
    if (acceptDurableEvent(message)) updateFromJobEvent(message);
  });
  return () => {
    events.close();
    window.clearInterval(balanceTick);
  };
});

function showMobileSection(section: MobileStep, mobile: boolean): boolean {
  return !mobile || mobileStep === section;
}
</script>

{#snippet inspectorContent(mobile: boolean)}
  <div class="flex min-h-full flex-col">
    {#if mobile}
      <nav class="grid grid-cols-5 border-b border-border px-2 py-2" aria-label="Studio setup steps">
        {#each ['setup', 'prompt', 'inputs', 'output', 'review'] as step (step)}
          <button
            type="button"
            class="focus-ring min-h-10 rounded px-1 text-[0.6875rem] font-semibold capitalize"
            class:bg-accent={mobileStep === step}
            class:text-accent-foreground={mobileStep === step}
            class:text-muted-foreground={mobileStep !== step}
            aria-current={mobileStep === step ? 'step' : undefined}
              onclick={() => (mobileStep = step as MobileStep)}
          >{step}</button>
        {/each}
      </nav>
    {/if}

    <div class="flex-1 px-5 py-5">
      {#if showMobileSection('setup', mobile)}
        <section aria-labelledby={`${data.modality}-workflow-heading`}>
          <p class="eyebrow-label">Essential</p>
          <div class="mt-1 flex items-center justify-between gap-3">
            <h2 id={`${data.modality}-workflow-heading`} class="text-base font-semibold tracking-tight">Workflow and model</h2>
            <button
              type="button"
              class="focus-ring grid size-8 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={favorites.includes(entryKey) ? 'Remove model from favorites' : 'Add model to favorites'}
              aria-pressed={favorites.includes(entryKey)}
              onclick={toggleFavorite}
            >
              <AppIcon name="heart" size={17} class={favorites.includes(entryKey) ? 'text-primary' : ''} />
            </button>
          </div>
          <div class="mt-4 grid gap-4">
            {#if data.modality === 'image'}
              <fieldset class="grid gap-2">
                <legend class="text-xs font-semibold">Creative intent</legend>
                <div class="grid grid-cols-2 gap-1 rounded-[var(--radius)] bg-muted p-1">
                  {#each [
                    { workflow: 'text-to-image', label: 'Text to image' },
                    { workflow: 'image-edit', label: 'Edit image' }
                  ] as intent (intent.workflow)}
                    <label
                      class="focus-within:ring-2 focus-within:ring-ring flex min-h-10 cursor-pointer items-center justify-center rounded px-2 text-center text-xs font-semibold"
                      class:bg-background={
                        intent.workflow === 'text-to-image'
                          ? selectedEntry.workflow === 'text-to-image'
                          : selectedEntry.workflow !== 'text-to-image'
                      }
                      class:shadow-[var(--shadow-xs)]={
                        intent.workflow === 'text-to-image'
                          ? selectedEntry.workflow === 'text-to-image'
                          : selectedEntry.workflow !== 'text-to-image'
                      }
                    >
                      <input
                        class="sr-only"
                        type="radio"
                        name={`${data.modality}-creative-intent`}
                        value={intent.workflow}
                        checked={
                          intent.workflow === 'text-to-image'
                            ? selectedEntry.workflow === 'text-to-image'
                            : selectedEntry.workflow !== 'text-to-image'
                        }
                        onchange={() => switchWorkflow(intent.workflow)}
                      />
                      {intent.label}
                    </label>
                  {/each}
                </div>
              </fieldset>
            {:else}
              <fieldset class="grid gap-2">
                <legend class="text-xs font-semibold">Creative intent</legend>
                <div class="grid max-h-40 grid-cols-2 gap-1 overflow-y-auto rounded-[var(--radius)] bg-muted p-1">
                  {#each workflows as workflow (workflow)}
                    <label
                      class="focus-within:ring-2 focus-within:ring-ring flex min-h-10 cursor-pointer items-center rounded px-2 text-xs font-semibold"
                      class:bg-background={selectedEntry.workflow === workflow}
                      class:shadow-[var(--shadow-xs)]={selectedEntry.workflow === workflow}
                    >
                      <input
                        class="sr-only"
                        type="radio"
                        name={`${data.modality}-creative-intent`}
                        value={workflow}
                        checked={selectedEntry.workflow === workflow}
                        onchange={() => switchWorkflow(workflow)}
                      />
                      {workflowLabel(workflow)}
                    </label>
                  {/each}
                </div>
              </fieldset>
            {/if}
            <ModelPicker
              entries={modelEntries}
              selectedKey={entryKey}
              {favorites}
              onchange={switchEntry}
            />
          </div>
          <p class="mt-3 font-mono text-[0.6875rem] text-muted-foreground">{selectedEntry.publicModelId}</p>
          {#if selectedEntry.limitations.length}
            <details class="mt-3 text-xs leading-5 text-muted-foreground">
              <summary class="focus-ring w-fit cursor-pointer rounded font-semibold text-foreground">Verified note for this model</summary>
              <p class="mt-1.5">{selectedEntry.limitations[0]}</p>
            </details>
          {/if}
          {#if setupFields.length}
            <div class="mt-5 grid gap-4">
              {#each setupFields as field (field.key)}
                {#if isAutomaticField(field)}
                  <ChoiceField
                    {field}
                    value={guided[field.key]}
                    automatic={automaticFields[field.key]}
                    automaticChoice={automaticFieldChoice(selectedEntry, field.key, roleInputs)}
                    onchange={updateChoice}
                  />
                {:else}
                  <FieldControl {field} value={guided[field.key]} onchange={updateGuided} />
                {/if}
              {/each}
            </div>
          {/if}
        </section>
      {/if}

      {#if showMobileSection('prompt', mobile)}
        <section class={!mobile ? 'mt-6 border-t border-border pt-5' : ''} aria-labelledby={`${data.modality}-prompt-heading`}>
          <p class="eyebrow-label">Essential</p>
          <h2 id={`${data.modality}-prompt-heading`} class="mt-1 text-sm font-semibold">Prompt</h2>
          {#if promptFields.length}
            <div class="mt-3 grid gap-4">
              {#each promptFields as field (field.key)}
                <FieldControl {field} value={guided[field.key]} onchange={updateGuided} />
              {/each}
            </div>
          {:else}
            <p class="mt-2 text-sm leading-6 text-muted-foreground">This workflow is controlled by its media roles and does not accept a prompt.</p>
          {/if}
        </section>
      {/if}

      {#if showMobileSection('inputs', mobile)}
        <section class={!mobile ? 'mt-6 border-t border-border pt-5' : ''} aria-labelledby={`${data.modality}-inputs-heading`}>
          <p class="eyebrow-label">Essential</p>
          <h2 id={`${data.modality}-inputs-heading`} class="mt-1 text-sm font-semibold">Required media</h2>
          {#if selectedEntry.inputRoles.length}
            <div class="mt-3 grid gap-4">
              {#each selectedEntry.inputRoles as role (role.role)}
                <div class="rounded-[var(--radius)] bg-muted px-3 py-3">
                  <div class="flex items-start justify-between gap-3">
                    <div>
                      <p class="text-sm font-semibold">{roleLabel(role.role)}{role.required ? ' *' : ''}</p>
                      <p class="mt-0.5 text-xs text-muted-foreground">
                        {role.mediaKind} · {role.formats.join(', ')} · {role.max === null ? `${role.min}+` : `${role.min}–${role.max}`}
                      </p>
                    </div>
                    <Badge tone={role.required ? 'info' : 'neutral'}>{role.required ? 'Required' : 'Optional'}</Badge>
                  </div>
                  {#if (roleInputs[role.role] ?? []).length}
                    <ul class="mt-3 grid list-none gap-2 p-0">
                      {#each roleInputs[role.role] ?? [] as input, index (input.id)}
                        <li class="flex items-center gap-2 rounded bg-background px-2.5 py-2 text-xs">
                          <span class="grid size-5 shrink-0 place-items-center rounded bg-stage text-stage-foreground">{index + 1}</span>
                          <span class="min-w-0 flex-1">
                            <span class="block truncate">{input.name}</span>
                            {#if input.width && input.height}
                              <span class="mt-0.5 block text-[0.6875rem] text-muted-foreground">
                                {mediaMetadataLabel({ width: input.width, height: input.height, ...(input.durationSeconds === undefined ? {} : { durationSeconds: input.durationSeconds }) })}
                              </span>
                            {:else if input.metadataProbe === 'unavailable'}
                              <span class="mt-0.5 block text-[0.6875rem] leading-4 text-warning">Browser metadata unavailable; verify model dimensions and duration manually.</span>
                            {/if}
                          </span>
                          <Badge tone={input.source === 'uploaded' ? 'success' : 'neutral'}>{input.source}</Badge>
                          <button type="button" class="focus-ring rounded px-1 text-muted-foreground hover:text-destructive" aria-label={`Remove ${input.name}`} onclick={() => removeRoleInput(role.role, input.id)}>Remove</button>
                        </li>
                      {/each}
                    </ul>
                  {/if}
                  <div class="mt-3 grid gap-2">
                    {#if role.mediaKind !== 'audio'}
                      <label class="focus-ring flex min-h-9 cursor-pointer items-center justify-center gap-2 rounded-[var(--radius)] border border-border bg-background px-3 text-xs font-semibold shadow-[var(--shadow-xs)] hover:bg-muted">
                        <AppIcon name="upload" size={15} />
                        {uploadingRole === role.role ? 'Uploading…' : 'Add local file'}
                        <input
                          class="sr-only"
                          type="file"
                          accept={mediaAccept(role)}
                          multiple={role.max !== 1}
                          disabled={uploadingRole !== null || !hasApiKey}
                          onchange={(event) => void uploadFiles(role.role, event.currentTarget.files)}
                        />
                      </label>
                      {#if !hasApiKey}<p class="text-xs text-muted-foreground">Configure the API key before streaming a local source to Poyo.</p>{/if}
                    {/if}
                    <div class="flex gap-2">
                      <label class="sr-only" for={`${entryKey}-${role.role}-url`}>{roleLabel(role.role)} remote URL</label>
                      <input
                        id={`${entryKey}-${role.role}-url`}
                        type="url"
                        class="focus-ring h-9 min-w-0 flex-1 rounded-[var(--radius)] border border-input bg-background px-2.5 text-xs"
                        placeholder="https://…"
                        value={remoteDrafts[role.role] ?? ''}
                        oninput={(event) => (remoteDrafts[role.role] = event.currentTarget.value)}
                      />
                      <button type="button" class="focus-ring min-h-9 rounded-[var(--radius)] border border-border bg-background px-2.5 text-xs font-semibold" onclick={() => addRemote(role.role)}>Add URL</button>
                    </div>
                  </div>
                  {#if uploadProgress[role.role]}
                    <div class="mt-2 rounded bg-background px-2.5 py-2" role="status" aria-live="polite">
                      <div class="flex items-center justify-between gap-3 text-[0.6875rem] font-semibold">
                        <span>Local browser upload</span>
                        {#if uploadProgress[role.role]?.percent !== null}<span>{uploadProgress[role.role]?.percent}%</span>{/if}
                      </div>
                      {#if uploadProgress[role.role]?.percent !== null}
                        <progress class="mt-1.5 h-1.5 w-full accent-primary" max="100" value={uploadProgress[role.role]?.percent ?? 0}>{uploadProgress[role.role]?.percent}%</progress>
                      {/if}
                      <p class="mt-1 text-[0.6875rem] leading-4 text-muted-foreground">{uploadProgress[role.role]?.message}</p>
                    </div>
                  {/if}
                  {#if uploadError[role.role]}<p class="mt-2 text-xs leading-5 text-destructive">{uploadError[role.role]}</p>{/if}
                </div>
              {/each}
            </div>
            <p class="mt-3 text-xs leading-5 text-muted-foreground">Dimensions and duration are measured by this browser when its media decoder supports the file. The server independently rechecks bytes, type and signature, but cannot probe visual metadata before Poyo upload.</p>
          {:else}
            <p class="mt-2 text-sm text-muted-foreground">No source media is required for this workflow.</p>
          {/if}
        </section>
      {/if}

      {#if showMobileSection('output', mobile)}
        <section class={!mobile ? 'mt-6 border-t border-border pt-5' : ''} aria-labelledby={`${data.modality}-output-heading`}>
          <p class="eyebrow-label">Common</p>
          <h2 id={`${data.modality}-output-heading`} class="mt-1 text-sm font-semibold">Output and common options</h2>
          {#if availableSizeModes.length > 1}
            <fieldset class="mt-3">
              <legend class="text-xs font-semibold">Size mode</legend>
              <div class="mt-2 grid grid-cols-2 gap-1 rounded-[var(--radius)] bg-muted p-1">
                {#each availableSizeModes as mode (mode)}
                  <label class="focus-within:ring-2 focus-within:ring-ring flex min-h-8 cursor-pointer items-center justify-center rounded px-2 text-xs font-semibold" class:bg-background={sizeMode === mode} class:shadow-[var(--shadow-xs)]={sizeMode === mode}>
                    <input class="sr-only" type="radio" name={`${entryKey}-size-mode`} value={mode} checked={sizeMode === mode} onchange={() => chooseSizeMode(mode)} />
                    {mode === 'aspect-ratio' ? 'Aspect ratio' : mode[0]?.toUpperCase() + mode.slice(1)}
                  </label>
                {/each}
              </div>
            </fieldset>
          {/if}
          <div class="mt-4 grid gap-4">
            {#each commonFields as field (field.key)}
              {#if isAutomaticField(field)}
                <ChoiceField
                  {field}
                  value={guided[field.key]}
                  automatic={automaticFields[field.key]}
                  automaticChoice={automaticFieldChoice(selectedEntry, field.key, roleInputs)}
                  onchange={updateChoice}
                />
              {:else}
                <FieldControl {field} value={field.key === 'dimensions' ? { width: guided.width, height: guided.height } : guided[field.key]} onchange={updateGuided} />
              {/if}
            {/each}
          </div>
        </section>
      {/if}

      {#if showMobileSection('review', mobile)}
        <section class={!mobile ? 'mt-6 border-t border-border pt-5' : ''} aria-labelledby={`${data.modality}-review-heading`}>
          <p class="eyebrow-label">Review</p>
          <h2 id={`${data.modality}-review-heading`} class="mt-1 text-sm font-semibold">Advanced and expert request</h2>
          {#if advancedFields.length}
            <details class="mt-3 border-y border-border py-3">
              <summary class="focus-ring flex cursor-pointer items-center justify-between rounded text-sm font-semibold">
                Advanced settings
                <Badge tone={advancedChanged ? 'info' : 'neutral'}>{advancedChanged} changed</Badge>
              </summary>
              <div class="mt-4 grid gap-4">
                {#each advancedFields as field (field.key)}
                  <FieldControl {field} value={field.key === 'dimensions' ? { width: guided.width, height: guided.height } : guided[field.key]} onchange={updateGuided} />
                {/each}
              </div>
            </details>
          {/if}
          <details class="mt-3 border-y border-border py-3">
            <summary class="focus-ring cursor-pointer rounded text-sm font-semibold">Expert request</summary>
            <p class="mt-3 text-xs leading-5 text-muted-foreground">Overrides are unverified, cannot replace guided or protected fields, and never include credentials or local media bodies.</p>
            <label for={`${data.modality}-expert-json`} class="mt-3 block text-xs font-semibold">Unverified override object</label>
            <textarea
              id={`${data.modality}-expert-json`}
              class="focus-ring mt-1.5 w-full rounded-[var(--radius)] border border-input bg-stage px-3 py-2 font-mono text-xs leading-5 text-stage-foreground"
              rows="5"
              placeholder={'{\n  "new_parameter": "value"\n}'}
              value={expertText}
              oninput={(event) => {
                expertText = event.currentTarget.value;
                previewRevision += 1;
              }}
            ></textarea>
            {#if preview?.expertDiff.length}
              <div class="mt-2 flex flex-wrap gap-1">
                {#each preview.expertDiff as item (item.key)}<Badge tone="experimental">{item.key} · Unverified</Badge>{/each}
              </div>
            {/if}
            <div class="mt-3">
              <div class="flex items-center justify-between gap-2">
                <span class="text-xs font-semibold">Normalized payload</span>
                <Badge tone={preview ? 'success' : 'neutral'}>{preview ? 'Validated' : 'Unavailable'}</Badge>
              </div>
              <pre class="mt-2 max-h-56 overflow-auto rounded-[var(--radius)] bg-stage p-3 text-left font-mono text-[0.6875rem] leading-5 text-stage-foreground">{preview ? JSON.stringify(preview.request, null, 2) : 'Fix validation issues to inspect the final request.'}</pre>
            </div>
          </details>
        </section>
      {/if}
    </div>

    <div class="sticky bottom-0 border-t border-border bg-card px-5 py-4 shadow-[0_-8px_20px_hsl(0_0%_0%/0.06)]">
      {#if showPresetForm}
        <div class="mb-3 grid gap-2 rounded-[var(--radius)] bg-muted p-3">
          <label class="grid gap-1 text-xs font-semibold" for={`${data.modality}-preset-name`}>
            Preset name
            <input id={`${data.modality}-preset-name`} class="focus-ring h-9 rounded-[var(--radius)] border border-input bg-background px-2.5 text-sm" maxlength="120" bind:value={presetName} />
          </label>
          <label class="grid gap-1 text-xs font-semibold" for={`${data.modality}-preset-description`}>
            Description
            <textarea id={`${data.modality}-preset-description`} class="focus-ring rounded-[var(--radius)] border border-input bg-background px-2.5 py-2 text-sm" rows="2" maxlength="500" bind:value={presetDescription}></textarea>
          </label>
          <div class="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onclick={() => (showPresetForm = false)}>Cancel</Button>
            <Button size="sm" variant="primary" onclick={savePreset}>Save preset</Button>
          </div>
        </div>
      {/if}
      {#if presetMessage}<p class="mb-2 text-xs leading-5 text-muted-foreground">{presetMessage}</p>{/if}
      {#if restoredMessage}<p class="mb-2 text-xs leading-5 text-muted-foreground">{restoredMessage}</p>{/if}
      {#if previewIssues.length}
        <div class="mb-2" role="alert">
          {#each previewIssues.slice(0, 2) as issue (issue)}<p class="text-xs leading-5 text-destructive">{issue}</p>{/each}
        </div>
      {:else}
        <p class="mb-2 text-xs text-muted-foreground">
          {previewState === 'validating' ? 'Validating request…' : preview ? 'Request validated locally.' : 'Complete required fields to validate.'}
        </p>
      {/if}
      {#if recoveryExhausted}
        <div class="mb-3 flex flex-wrap gap-2" aria-label="Unresolved paid action recovery">
          <Button variant="outline" size="sm" onclick={() => void reconcilePendingAction()}>Check action again</Button>
          {#if recoveryConcluded}<Button variant="ghost" size="sm" onclick={abandonPendingAction}>Acknowledge risk and start a new action</Button>{/if}
        </div>
      {/if}
      <div class="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
        <span class="text-muted-foreground">
          {#if completedCredits !== null}
            Charged <strong class="text-foreground">{completedCredits} credits</strong> for this generation
          {:else}
            Billed per generation · Poyo does not publish a pre-generation estimate, so the exact cost appears after completion
          {/if}
        </span>
        <span class="flex items-center gap-1.5">
          {#if balance}
            <span class:text-warning={balanceStale} title={`Balance as of ${new Date(balance.fetchedAt).toLocaleString()}`}>
              {balance.credits} credits{balanceStale ? ' · stale' : ''}
            </span>
          {:else}
            <span class="text-muted-foreground">{hasApiKey ? 'Balance not loaded' : 'API key required'}</span>
          {/if}
          <button type="button" class="focus-ring grid size-6 place-items-center rounded text-muted-foreground hover:text-foreground disabled:opacity-50" aria-label="Refresh balance" onclick={refreshBalanceSnapshot} disabled={balanceRefreshing || !hasApiKey}>
            <AppIcon name="refresh" size={13} />
          </button>
        </span>
      </div>
      <div class="grid grid-cols-2 gap-2">
        <Button variant="ghost" size="sm" onclick={resetDraft}>Reset</Button>
        <Button variant="outline" size="sm" onclick={() => (showPresetForm = !showPresetForm)}>Save preset</Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!preview || submitting || submissionLocked || batchSubmitting}
          onclick={() => void addCurrentToBatch()}
        >
          {editingBatchItemId ? 'Update batch item' : 'Add to batch'}
        </Button>
        <BatchReview
          modality={data.modality}
          items={batch.items}
          submitting={batchSubmitting}
          canSubmit={hasApiKey}
          onedit={editBatchItem}
          onduplicate={duplicateBatch}
          onremove={removeBatchItem}
          onsubmit={() => void submitBatch()}
          onretry={(item) => void retryBatchItem(item)}
          onreconcile={(item) => void reconcileBatchItem(item)}
          onabandon={abandonBatchItem}
        />
        <Button
          variant="primary"
          class="col-span-2 min-h-10"
          disabled={!preview || submitting || submissionLocked || !hasApiKey}
          ariaDescribedby={`${data.modality}-generate-status`}
          onclick={submit}
        >
          {submitting ? 'Creating Poyo task…' : `Generate ${data.modality}`}
        </Button>
      </div>
      <p id={`${data.modality}-generate-status`} class="sr-only">
        {!hasApiKey ? 'Configure a Poyo API key before generating.' : submissionLocked ? 'The previous paid action has an unresolved outcome.' : preview ? 'Ready to generate.' : 'Request validation is incomplete.'}
      </p>
    </div>
  </div>
{/snippet}

<div
  class="studio-layout studio-functional"
  data-inspector-collapsed={inspectorCollapsed ? 'true' : 'false'}
  style={`--studio-inspector-width: ${inspectorWidth}px`}
>
  <section class="min-w-0 px-3 py-4 sm:px-5 sm:py-5 xl:px-6" aria-labelledby={`${data.modality}-stage-heading`}>
    <div class="mb-3 flex min-h-10 items-center justify-between gap-3 border-y border-border py-2 text-xs" aria-label="Generation lifecycle">
      <div class="flex min-w-0 items-center gap-2">
        <Badge tone={activeJob ? 'info' : preview ? 'success' : 'neutral'}>
          <AppIcon name={activeJob ? 'activity' : preview ? 'success' : 'pending'} size={12} />
          {submissionUnknown ? 'Outcome unknown' : activeJob ? activeJob.localPhase.replaceAll('_', ' ') : preview ? 'Ready' : 'Compose'}
        </Badge>
        <span class="truncate text-muted-foreground">
          {activeJob ? `${activeJob.remoteStatus.replaceAll('_', ' ')} · ${activeJob.publicModelId}` : workflowLabel(selectedEntry.workflow)}
        </span>
      </div>
      <div class="flex items-center gap-2">
        <Badge tone={connection === 'connected' ? 'success' : 'warning'}>{connection === 'connected' ? 'Live updates connected' : 'Live updates reconnecting'}</Badge>
        <button type="button" class="focus-ring hidden min-h-8 items-center gap-1.5 rounded px-2 text-xs font-semibold hover:bg-muted xl:inline-flex" onclick={() => (inspectorCollapsed = !inspectorCollapsed)}>
          <AppIcon name={inspectorCollapsed ? 'panel-open' : 'panel-close'} size={15} />
          {inspectorCollapsed ? 'Show setup' : 'Hide setup'}
        </button>
      </div>
    </div>

    <div class="media-stage grid place-items-center px-5 py-10 text-center">
      {#if resultJob && outputs?.some((output) => output.mediaUrl)}
        {@const shown = outputs.filter((output) => output.mediaUrl)}
        {@const current = shown[Math.min(selectedOutput, shown.length - 1)]}
        {#if current && current.mediaUrl}
          <div class="flex w-full max-w-4xl flex-col items-center gap-4">
            <h2 id={`${data.modality}-stage-heading`} class="sr-only">Generated {data.modality} result</h2>
            {#if current.mediaKind === 'video'}
              <!-- svelte-ignore a11y_media_has_caption -->
              <video src={current.mediaUrl} controls class="max-h-[68vh] max-w-full rounded-[var(--radius)] shadow-[var(--shadow-sm)]"></video>
            {:else}
              <img src={current.mediaUrl} alt={`Generated ${data.modality} for ${resultJob.publicModelId}`} class="max-h-[68vh] w-auto max-w-full rounded-[var(--radius)] object-contain shadow-[var(--shadow-sm)]" />
            {/if}
            {#if shown.length > 1}
              <div class="flex flex-wrap justify-center gap-2" aria-label="Generated outputs">
                {#each shown as output, index (output.outputId)}
                  <button type="button" class="focus-ring size-14 overflow-hidden rounded border" class:border-primary={index === selectedOutput} class:border-stage-border={index !== selectedOutput} aria-label={`Show output ${index + 1} of ${shown.length}`} aria-pressed={index === selectedOutput} onclick={() => (selectedOutput = index)}>
                    {#if output.mediaKind === 'video'}
                      <!-- svelte-ignore a11y_media_has_caption -->
                      <video src={output.mediaUrl ?? ''} muted class="size-full object-cover"></video>
                    {:else}
                      <img src={output.mediaUrl ?? ''} alt="" class="size-full object-cover" />
                    {/if}
                  </button>
                {/each}
              </div>
            {/if}
            <div class="flex flex-wrap items-center justify-center gap-2">
              <LinkButton href={`/jobs?selected=${resultJob.id}`} variant="outline" class="border-stage-border bg-stage-elevated text-stage-foreground hover:bg-stage-border">View job</LinkButton>
              <a href={current.mediaUrl} target="_blank" rel="noopener" class="focus-ring inline-flex min-h-9 items-center gap-2 rounded-[var(--radius)] border border-stage-border bg-stage-elevated px-3.5 text-sm font-semibold text-stage-foreground hover:bg-stage-border">Open</a>
              <a href={current.mediaUrl} download={current.fileName ?? ''} class="focus-ring inline-flex min-h-9 items-center gap-2 rounded-[var(--radius)] border border-stage-border bg-stage-elevated px-3.5 text-sm font-semibold text-stage-foreground hover:bg-stage-border">Download</a>
              <Button variant="ghost" class="text-stage-muted hover:bg-stage-elevated hover:text-stage-foreground" onclick={dismissResultPreview}>Remix</Button>
            </div>
          </div>
        {/if}
      {:else if activeJob}
        <div class="max-w-xl">
          <div class="mx-auto grid size-12 place-items-center rounded-lg bg-stage-elevated text-stage-foreground">
            <AppIcon name={activeJob.remoteStatus === 'failed' ? 'pending' : activeJob.localPhase === 'complete' ? 'success' : activeJob.failureDomain !== 'none' ? 'pending' : 'activity'} size={23} />
          </div>
          <p class="mt-5 text-xs font-semibold tracking-[0.12em] text-stage-muted uppercase">{activeJob.publicModelId}</p>
          <h2 id={`${data.modality}-stage-heading`} class="mt-2 text-xl font-semibold tracking-tight text-stage-foreground">
            {submissionUnknown
              ? 'Submission outcome needs reconciliation'
              : activeJob.remoteStatus === 'failed'
                ? 'Poyo generation failed'
                : activeJob.localPhase === 'complete'
                  ? 'Generation verified locally'
                  : activeJob.localPhase === 'requires_attention'
                    ? 'Job needs attention'
                    : activeJob.localPhase === 'downloading'
                      ? 'Downloading and verifying'
                      : activeJob.remoteStatus === 'running'
                        ? 'Poyo is generating'
                        : 'Job submitted and persisted'}
          </h2>
          <p class="mx-auto mt-2 max-w-md text-sm leading-6 text-stage-muted">
            {submissionUnknown
              ? 'This request will not be submitted again automatically because doing so could spend credits twice.'
              : activeJob.remoteStatus === 'failed'
                ? 'Poyo authoritatively reported that the remote generation failed. No local download was attempted.'
                : activeJob.failureDomain === 'poll'
                  ? `Status check delayed. Last successful check ${activeJob.lastPolledAt ?? 'is not available'}.`
                  : activeJob.localPhase === 'complete'
                    ? outputsError
                      ? outputsError
                      : loadingOutputs
                        ? 'Loading the generated media…'
                        : 'The Poyo task finished and its downloaded outputs passed local verification.'
                    : activeJob.localPhase === 'downloading'
                      ? 'Poyo finished. The output is downloading and being verified locally before it appears here.'
                      : `Real state: ${activeJob.localPhase.replaceAll('_', ' ')} · ${activeJob.remoteStatus.replaceAll('_', ' ')}.`}
          </p>
          {#if activeJob.progress !== null}
            <div class="mx-auto mt-5 max-w-sm text-left">
              <div class="flex justify-between text-xs text-stage-muted"><span>Reported Poyo progress</span><span>{activeJob.progress}%</span></div>
              <progress class="mt-2 h-1.5 w-full accent-primary" value={activeJob.progress} max="100">{activeJob.progress}%</progress>
            </div>
          {/if}
          <div class="mt-6 flex flex-wrap justify-center gap-2">
            <LinkButton href={`/jobs?selected=${activeJob.id}`} variant="outline" class="border-stage-border bg-stage-elevated text-stage-foreground hover:bg-stage-border">View job details</LinkButton>
            {#if activeJob.localPhase === 'complete'}<Button variant="ghost" class="text-stage-muted hover:bg-stage-elevated hover:text-stage-foreground" onclick={() => (activeJob = null)}>Remix settings</Button>{/if}
          </div>
        </div>
      {:else}
        <div class="max-w-xl">
          <div class="mx-auto grid size-12 place-items-center rounded-lg bg-stage-elevated text-stage-foreground">
            <AppIcon name={data.modality} size={23} />
          </div>
          <p class="mt-5 text-xs font-semibold tracking-[0.12em] text-stage-muted uppercase">{selectedEntry.provider}</p>
          <h2 id={`${data.modality}-stage-heading`} class="mt-2 text-xl font-semibold tracking-tight text-stage-foreground">{selectedEntry.displayName}</h2>
          <p class="mx-auto mt-2 max-w-md font-serif text-base leading-7 text-stage-muted">
            {preview
              ? 'The guided request is valid. Review the exact normalized payload or generate when ready.'
              : `${workflowLabel(selectedEntry.workflow)} with ${selectedEntry.inputRoles.length ? `${selectedEntry.inputRoles.length} named media role${selectedEntry.inputRoles.length === 1 ? '' : 's'}` : 'no required source media'}.`}
          </p>
          <div class="mt-5 flex flex-wrap justify-center gap-2">
            <Badge tone="stage">{selectedEntry.status}</Badge>
            <Badge tone="neutral">Verified {new Date(selectedEntry.provenance.verifiedAt).toLocaleDateString()}</Badge>
            {#if selectedEntry.output.safetyChecker}<Badge tone="info">Safety checker: {guided.enableSafetyChecker ? 'On' : 'Off'}</Badge>{/if}
          </div>
        </div>
      {/if}
    </div>

    {#if allRoleInputs.length}
      <section class="mt-3" aria-label="Selected source media">
        <div class="flex gap-2 overflow-x-auto pb-1">
          {#each allRoleInputs as input (input.id)}
            <div class="min-w-44 rounded-[var(--radius)] bg-muted px-3 py-2 text-xs">
              <p class="font-semibold">{roleLabel(input.role)}</p>
              <p class="mt-1 truncate text-muted-foreground">{input.name}</p>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    <div class="studio-mobile-setup mt-3 items-center justify-between gap-4 rounded-[var(--radius)] bg-muted px-4 py-3">
      <div class="min-w-0">
        <p class="text-sm font-semibold">{selectedEntry.displayName}</p>
        <p class="truncate text-xs text-muted-foreground">{workflowLabel(selectedEntry.workflow)} · {preview ? 'valid' : 'needs review'}</p>
      </div>
      <Sheet bind:open={setupOpen} title={`${data.modality === 'image' ? 'Image' : 'Video'} setup`} description="Setup, prompt, inputs, output and review." side="right" triggerClass="focus-ring inline-flex min-h-9 shrink-0 items-center gap-2 rounded-[var(--radius)] border border-border bg-background px-3 text-sm font-semibold shadow-[var(--shadow-xs)] hover:bg-muted" contentClass="p-0" studioSheet>
        {#snippet trigger()}<AppIcon name="filters" size={16} /> Edit setup{/snippet}
        <div id="parameter-inspector-mobile" class="min-h-[calc(100dvh-5rem)]">{@render inspectorContent(true)}</div>
      </Sheet>
    </div>
  </section>

  {#if !inspectorCollapsed}
    <button
      type="button"
      class="studio-separator focus-ring"
      aria-label="Resize parameter inspector"
      title={`Resize parameter inspector · ${inspectorWidth} pixels`}
      onkeydown={resizeWithKeyboard}
      onpointerdown={startResize}
    ></button>
  {/if}

  <aside id="parameter-inspector" class="studio-inspector" aria-label="Parameter inspector">
    {@render inspectorContent(false)}
  </aside>
</div>
