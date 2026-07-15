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
  StudioRoleInput
} from '$lib/features/generation/contracts';
import {
  type BrowserMediaMetadata,
  mediaMetadataLabel,
  probeBrowserMedia,
  validateLocalFileSelection
} from '$lib/features/generation/media-preflight';
import {
  createJobRequest,
  initialGuidedValues,
  initialRoleInputs,
  mediaAccept,
  nextMonotonicEventId,
  parseExpertOverrides,
  pendingActionRecoveryDelay,
  presetValues,
  roleLabel,
  type SizeMode,
  sizeModes,
  valuesWithRoleInputs,
  visibleFields,
  workflowLabel
} from '$lib/features/generation/studio-controller';
import type {
  ExpertOverride,
  FieldDefinition,
  NormalizedPreview
} from '$lib/features/registry/types';
import FieldControl from './FieldControl.svelte';

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
  initialData.preset?.values.expertOverrides.length
    ? JSON.stringify(
        Object.fromEntries(
          initialData.preset.values.expertOverrides.map((item) => [item.key, item.value])
        ),
        null,
        2
      )
    : ''
);
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
let currentGuided = $derived(valuesWithRoleInputs(selectedEntry, guided, roleInputs));
let hasApiKey = $derived(data.apiKey.status === 'configured');
let allRoleInputs = $derived(Object.values(roleInputs).flat());

function updateGuided(key: string, value: unknown): void {
  if (value === undefined || value === '') delete guided[key];
  else guided[key] = value;
  dirty = true;
  previewRevision += 1;
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
  roleInputs = {};
  sizeMode = inferSizeMode(next, guided);
  expertText = '';
  preview = null;
  previewIssues = [];
  activeJob = null;
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

$effect(() => {
  previewRevision;
  entryKey;
  expertText;
  const timer = window.setTimeout(() => void requestPreview(), 260);
  return () => window.clearTimeout(timer);
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
  } finally {
    balanceRefreshing = false;
  }
}

async function submit(): Promise<void> {
  if (submitting || submissionLocked || !hasApiKey) return;
  submitting = true;
  if (!(await requestPreview())) {
    submitting = false;
    return;
  }
  let overrides: ExpertOverride[];
  try {
    overrides = parseExpertOverrides(expertText);
  } catch (error) {
    previewIssues = [error instanceof Error ? error.message : 'Expert overrides are invalid.'];
    submitting = false;
    return;
  }
  const action: PendingAction = {
    actionId: crypto.randomUUID(),
    entryKey,
    createdAt: Date.now()
  };
  storePendingAction(action);
  try {
    const response = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        createJobRequest(action.actionId, selectedEntry, guided, overrides, roleInputs)
      )
    });
    const result = (await response.json()) as { job?: StudioJobDto; error?: { message?: string } };
    if (!response.ok || !result.job) {
      submissionUnknown = true;
      submissionLocked = true;
      previewIssues = [
        `${result.error?.message ?? 'The local server did not confirm the job.'} The paid action remains locked until reconciliation.`
      ];
      void reconcilePendingAction();
      return;
    }
    clearPendingAction(action.actionId);
    activeJob = result.job;
    submissionLocked = true;
    dirty = false;
    void fetch('/api/model-preferences', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entryKey, used: true })
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

function resetDraft(): void {
  if (submissionUnknown || readPendingAction()) {
    previewIssues = [
      'Reset is blocked until the unknown paid action is reconciled with the local job database.'
    ];
    return;
  }
  guided = initialGuidedValues(selectedEntry);
  roleInputs = {};
  expertText = '';
  preview = null;
  previewIssues = [];
  activeJob = null;
  submissionUnknown = false;
  submissionLocked = false;
  dirty = false;
  sizeMode = inferSizeMode(selectedEntry, guided);
  previewRevision += 1;
}

async function savePreset(): Promise<void> {
  presetMessage = '';
  try {
    const overrides = parseExpertOverrides(expertText);
    const response = await fetch('/api/presets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entryKey,
        name: presetName,
        description: presetDescription,
        values: presetValues(data.modality, guided, overrides, roleInputs)
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
  if (!activeJob) return;
  const update = JSON.parse(event.data) as {
    jobId: string;
    localPhase: string;
    remoteStatus: string;
    failureDomain: string;
    progress: number | null;
    observedAt: string;
  };
  if (update.jobId !== activeJob.id) return;
  activeJob = {
    ...activeJob,
    localPhase: update.localPhase,
    remoteStatus: update.remoteStatus,
    failureDomain: update.failureDomain,
    progress: update.progress,
    updatedAt: update.observedAt
  };
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
      activeJob = result.job;
      entryKey = pending.entryKey;
      submissionUnknown = false;
      recoveryConcluded = false;
      recoveryExhausted = false;
      submissionLocked = true;
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
  void reconcilePendingAction();
  const events = new EventSource('/api/events/jobs');
  events.onopen = () => (connection = 'connected');
  events.onerror = () => (connection = 'reconnecting');
  events.addEventListener('snapshot', (event) => {
    const message = event as MessageEvent<string>;
    if (!acceptDurableEvent(message)) return;
    connection = 'connected';
    const snapshot = JSON.parse(message.data) as { jobs: StudioJobDto[] };
    const matching = activeJob
      ? snapshot.jobs.find((job) => job.id === activeJob?.id)
      : snapshot.jobs.find(
          (job) =>
            job.publicModelId === selectedEntry.publicModelId &&
            !['complete'].includes(job.localPhase)
        );
    if (matching) activeJob = matching;
  });
  events.addEventListener('job', (event) => {
    const message = event as MessageEvent<string>;
    if (acceptDurableEvent(message)) updateFromJobEvent(message);
  });
  return () => events.close();
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
          <div class="mt-4 grid gap-3">
            <label class="grid gap-1.5 text-xs font-semibold" for={`${data.modality}-workflow`}>
              Creative intent
              <select
                id={`${data.modality}-workflow`}
                class="focus-ring h-9 rounded-[var(--radius)] border border-input bg-background px-2.5 text-sm"
                value={selectedEntry.workflow}
                onchange={(event) => switchWorkflow(event.currentTarget.value)}
              >
                {#each workflows as workflow (workflow)}
                  <option value={workflow}>{workflowLabel(workflow)}</option>
                {/each}
              </select>
            </label>
            <label class="grid gap-1.5 text-xs font-semibold" for={`${data.modality}-model`}>
              Audited model
              <select
                id={`${data.modality}-model`}
                class="focus-ring h-9 rounded-[var(--radius)] border border-input bg-background px-2.5 text-sm"
                value={entryKey}
                onchange={(event) => {
                  const next = data.entries.find((entry) => entry.key === event.currentTarget.value);
                  if (next) switchEntry(next);
                }}
              >
                {#each modelEntries as entry (entry.key)}
                  <option value={entry.key}>{favorites.includes(entry.key) ? '★ ' : ''}{entry.displayName} · {entry.provider}</option>
                {/each}
              </select>
            </label>
          </div>
          <p class="mt-3 font-mono text-[0.6875rem] text-muted-foreground">{selectedEntry.publicModelId}</p>
          {#if selectedEntry.limitations.length}
            <div class="mt-3 rounded-[var(--radius)] bg-warning/10 px-3 py-2 text-xs leading-5 text-foreground">
              <strong>Known limitation:</strong> {selectedEntry.limitations[0]}
            </div>
          {/if}
          {#if setupFields.length}
            <div class="mt-5 grid gap-4">
              {#each setupFields as field (field.key)}
                <FieldControl {field} value={guided[field.key]} onchange={updateGuided} />
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
              {#if selectedEntry.family === 'Seedream 5.0 Pro'}
                <p class="mt-2 text-xs leading-5 text-warning">Poyo currently accepts resolution or aspect ratio for Seedream 5.0 Pro, never both. The unselected concept is not sent.</p>
              {/if}
            </fieldset>
          {/if}
          <div class="mt-4 grid gap-4">
            {#each commonFields as field (field.key)}
              <FieldControl {field} value={field.key === 'dimensions' ? { width: guided.width, height: guided.height } : guided[field.key]} onchange={updateGuided} />
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
      <div class="mb-3 flex items-center justify-between gap-3 text-xs">
        <span>Estimated credits: <strong>Unavailable</strong></span>
        <button type="button" class="focus-ring rounded text-right text-muted-foreground hover:text-foreground" onclick={refreshBalanceSnapshot} disabled={balanceRefreshing || !hasApiKey}>
          {balance ? `${balance.credits} credits · ${new Date(balance.fetchedAt).toLocaleString()}` : hasApiKey ? 'Balance not refreshed' : 'API key required'}
        </button>
      </div>
      <div class="grid grid-cols-[auto_auto_1fr] gap-2">
        <Button variant="ghost" size="sm" onclick={resetDraft}>Reset</Button>
        <Button variant="outline" size="sm" onclick={() => (showPresetForm = !showPresetForm)}>Save preset</Button>
        <Button
          variant="primary"
          class="min-h-10"
          disabled={!preview || submitting || submissionLocked || !hasApiKey}
          ariaDescribedby={`${data.modality}-generate-status`}
          onclick={submit}
        >
          {submitting ? 'Creating Poyo task…' : `Generate ${data.modality}`}
        </Button>
      </div>
      <p id={`${data.modality}-generate-status`} class="sr-only">
        {!hasApiKey ? 'Configure a Poyo API key before generating.' : submissionLocked ? 'This request has already been submitted.' : preview ? 'Ready to generate.' : 'Request validation is incomplete.'}
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
          {activeJob ? `${activeJob.remoteStatus.replaceAll('_', ' ')} · ${selectedEntry.displayName}` : workflowLabel(selectedEntry.workflow)}
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
      {#if activeJob}
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
                  ? 'The Poyo task finished and its downloaded outputs passed local verification.'
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
