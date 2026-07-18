<script lang="ts">
import { untrack } from 'svelte';
import { goto, invalidateAll } from '$app/navigation';
import SettingsNavigation from '$lib/components/settings/SettingsNavigation.svelte';
import ThemeToggle from '$lib/components/shell/ThemeToggle.svelte';
import AppIcon from '$lib/components/ui/AppIcon.svelte';
import Badge from '$lib/components/ui/Badge.svelte';
import type { CleanupConsequence, CleanupPreviewDto } from '$lib/features/cleanup/contracts';
import { byteSizeLabel, dateTimeLabel } from '$lib/features/library/presentation';
import type { SettingsDto, StorageRootSettingsDto } from '$lib/features/settings/contracts';
import {
  apiKeyUiState,
  cleanupConsequenceLabel,
  cleanupPolicyRequest,
  credentialBackendLabel,
  credentialBackendUiState,
  operationsRequest,
  settingsDraft,
  storageRootUiState
} from '$lib/features/settings/controller';
import { resolveTheme, themeStorageKey } from '$lib/theme';
import type { PageData } from './$types';

let { data }: { data: PageData } = $props();
const initial = untrack(() => data);
let settings = $state<SettingsDto>(initial.settings);
let storageRoot = $state<StorageRootSettingsDto>(initial.storageRoot);
let rootChoice = $state<'project' | 'platform'>(
  initial.storageRoot.selected.kind === 'platform' ? 'platform' : 'project'
);
let outputLocation = $state(initial.outputLocation);
let directoryInput = $state('');
let directoryCheck = $state<{ ok: boolean; message: string; freeBytes: number | null } | null>(
  null
);
// Invalidate a prior directory check when the input changes so Save can't act on a stale "ok".
$effect(() => {
  directoryInput;
  directoryCheck = null;
});
let draft = $state(settingsDraft(initial.settings));
let connectivity = $state(initial.connectivity);
let account = $state(initial.balance?.email ?? null);
let apiKeyInput = $state('');
let credentialChoice = $state<'file' | 'os'>(initial.settings.apiKey.selectedBackend);
let replaceExistingCredential = $state(false);
let pending = $state<string | null>(null);
let message = $state('');
let errorMessage = $state('');
let consequence = $state<CleanupConsequence>(initial.settings.localCleanup.consequence);
let preview = $state<CleanupPreviewDto | null>(null);
let cleanupConfirmed = $state(false);

let keyState = $derived(apiKeyUiState(settings.apiKey));
let credentialState = $derived(credentialBackendUiState(settings.apiKey));
let rootState = $derived(storageRootUiState(storageRoot));

async function request<T>(path: string, method: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: { code?: string; message?: string };
    result?: { message?: string };
  };
  if (!response.ok) {
    const error = new Error(
      payload.error?.message ?? payload.result?.message ?? `Request failed (${response.status}).`
    );
    Object.assign(error, { code: payload.error?.code });
    throw error;
  }
  return payload;
}

async function run(name: string, callback: () => Promise<void>): Promise<void> {
  pending = name;
  message = '';
  errorMessage = '';
  try {
    await callback();
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'The local operation failed.';
  } finally {
    pending = null;
  }
}

function adopt(next: SettingsDto): void {
  settings = next;
  draft = settingsDraft(next);
  consequence = next.localCleanup.consequence;
}

function checkOutputDirectory(): void {
  if (!directoryInput.trim()) return;
  void run('check-dir', async () => {
    // The check endpoint returns a structured `result` for both success and expected validation
    // failures (422), so read it directly rather than via request(), whose throw-on-non-2xx would
    // drop the per-field feedback and leave only the page-level error banner.
    const response = await fetch('/api/settings/output-location', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directory: directoryInput })
    });
    const payload = (await response.json().catch(() => ({}))) as {
      result?: NonNullable<typeof directoryCheck>;
      error?: { message?: string };
    };
    if (!payload.result)
      throw new Error(payload.error?.message ?? `Request failed (${response.status}).`);
    directoryCheck = payload.result;
  });
}

function saveOutputDirectory(): void {
  void run('save-dir', async () => {
    const result = await request<{
      result: typeof directoryCheck;
      outputLocation: typeof outputLocation;
    }>('/api/settings/output-location', 'PUT', { directory: directoryInput });
    outputLocation = result.outputLocation;
    directoryCheck = result.result;
    message = outputLocation.requiresRestart
      ? 'Saved. New outputs use this folder after the next restart; existing media stays available.'
      : 'Output folder updated.';
  });
}

function resetOutputDirectory(): void {
  void run('reset-dir', async () => {
    const result = await request<{ outputLocation: typeof outputLocation }>(
      '/api/settings/output-location',
      'DELETE',
      {}
    );
    outputLocation = result.outputLocation;
    directoryInput = '';
    directoryCheck = null;
    message = 'Reverted to the default output location. It applies after the next restart.';
  });
}

function rerunSetup(): void {
  void run('rerun', async () => {
    await request('/api/onboarding', 'PUT', { reopen: true });
    await goto('/welcome');
  });
}

function applyBrowserTheme(): void {
  localStorage.setItem(themeStorageKey, draft.theme);
  const resolved = resolveTheme(
    draft.theme,
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
  document.documentElement.classList.toggle('dark', resolved === 'dark');
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = draft.theme;
}

function saveOperations(): void {
  void run('operations', async () => {
    const result = await request<{ settings: SettingsDto }>('/api/settings', 'PUT', {
      operations: operationsRequest(draft)
    });
    adopt(result.settings);
    applyBrowserTheme();
    message = 'Operational settings saved.';
  });
}

function configureApiKey(event: SubmitEvent): void {
  event.preventDefault();
  if (!keyState.canConfigure || !apiKeyInput.trim()) return;
  void run('api-key', async () => {
    try {
      const result = await request<{ apiKey: SettingsDto['apiKey'] }>(
        '/api/settings/api-key',
        'PUT',
        { apiKey: apiKeyInput }
      );
      settings = { ...settings, apiKey: result.apiKey };
      message =
        'The key was stored only by the local server. Its value is no longer available to this page.';
    } finally {
      apiKeyInput = '';
    }
  });
}

function switchCredentialBackend(): void {
  if (
    !settings.apiKey.localMutationAvailable ||
    credentialChoice === settings.apiKey.selectedBackend
  )
    return;
  void run('credential-backend', async () => {
    try {
      const result = await request<{ apiKey: SettingsDto['apiKey'] }>(
        '/api/settings/credential-backend',
        'POST',
        {
          backend: credentialChoice,
          ...(apiKeyInput.trim() ? { apiKey: apiKeyInput } : {}),
          replaceExisting: replaceExistingCredential
        }
      );
      settings = { ...settings, apiKey: result.apiKey };
      credentialChoice = result.apiKey.selectedBackend;
      replaceExistingCredential = false;
      message = result.apiKey.transition
        ? `Key moved to ${credentialBackendLabel(result.apiKey.selectedBackend)}. The target is authoritative; the previous copy is retained pending cleanup.`
        : `Key moved to ${credentialBackendLabel(result.apiKey.selectedBackend)} and verified before the previous copy was removed.`;
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'backend_unavailable' &&
        credentialChoice === 'os'
      ) {
        settings = {
          ...settings,
          apiKey: {
            ...settings.apiKey,
            backendAvailability: { ...settings.apiKey.backendAvailability, os: 'unavailable' }
          }
        };
      }
      throw error;
    } finally {
      apiKeyInput = '';
    }
  });
}

function resolveCredentialConflict(
  action: NonNullable<SettingsDto['apiKey']['transition']>['actions'][number]
): void {
  void run('credential-conflict', async () => {
    const result = await request<{ apiKey: SettingsDto['apiKey'] }>(
      '/api/settings/credential-backend/conflict',
      'POST',
      { action }
    );
    settings = { ...settings, apiKey: result.apiKey };
    credentialChoice = result.apiKey.selectedBackend;
    replaceExistingCredential = false;
    message =
      action === 'abandon'
        ? 'The stale credential move was abandoned. Both stored copies were left unchanged.'
        : action === 'acknowledge-retained-source'
          ? 'The selected backend remains authoritative. The previous copy is explicitly retained and still reported.'
          : action === 'retry-cleanup'
            ? result.apiKey.transition
              ? 'Cleanup remains pending. No unverified credential copy was deleted.'
              : 'Credential cleanup was verified and completed.'
            : action === 'resume-transition'
              ? `The credential move resumed after fresh verification. ${credentialBackendLabel(result.apiKey.selectedBackend)} is now selected.`
              : `Fresh replacement authorization was verified. ${credentialBackendLabel(result.apiKey.selectedBackend)} is now selected.`;
  });
}

function relocateStorageRoot(): void {
  if (
    storageRoot.environmentManaged ||
    !storageRoot.mutationAvailable ||
    rootChoice === storageRoot.current.kind
  )
    return;
  void run('storage-root', async () => {
    const result = await request<{ storageRoot: StorageRootSettingsDto }>(
      '/api/settings/storage-root',
      'POST',
      { targetRootKind: rootChoice }
    );
    storageRoot = result.storageRoot;
    message = `${result.storageRoot.selected.label} is selected. Restart the Studio to verify and activate the copied data. Writes remain frozen until restart.`;
  });
}

function removeApiKey(): void {
  if (!keyState.canRemove || !confirm('Remove the locally stored Poyo API key?')) return;
  void run('remove-key', async () => {
    const result = await request<{ apiKey: SettingsDto['apiKey'] }>(
      '/api/settings/api-key',
      'DELETE',
      {}
    );
    settings = { ...settings, apiKey: result.apiKey };
    connectivity = { status: null, checkedAt: null };
    account = null;
    message = 'The locally stored key was removed.';
    await invalidateAll();
  });
}

function testConnectivity(): void {
  if (!keyState.canTest) return;
  void run('connectivity', async () => {
    const result = await request<{
      connectivity: { status: string; checkedAt: string; account: string | null };
    }>('/api/settings/api-key/connectivity', 'POST', {});
    connectivity = result.connectivity;
    account = result.connectivity.account;
    message = 'Poyo connectivity verified.';
    await invalidateAll();
  });
}

function clearPreview(): void {
  preview = null;
  cleanupConfirmed = false;
}

function previewCleanup(): void {
  void run('preview', async () => {
    const updated = await request<{ settings: SettingsDto }>('/api/settings', 'PUT', {
      localCleanup: cleanupPolicyRequest(draft, consequence)
    });
    adopt(updated.settings);
    const result = await request<{ preview: CleanupPreviewDto }>('/api/cleanup/preview', 'POST', {
      consequence
    });
    preview = result.preview;
    cleanupConfirmed = false;
    message = preview.candidates.length
      ? 'Automatic cleanup policy saved. Current candidates may be processed by the background scheduler; confirm below to run them now.'
      : 'Automatic cleanup policy saved. No files are currently eligible.';
  });
}

function applyCleanup(): void {
  if (!preview || !cleanupConfirmed) return;
  void run('apply-cleanup', async () => {
    const result = await request<{ scheduled: number }>('/api/cleanup/apply', 'POST', {
      token: preview?.token,
      confirmed: true
    });
    message = `${result.scheduled} cleanup ${result.scheduled === 1 ? 'action was' : 'actions were'} scheduled. The durable worker records each result.`;
    preview = null;
    cleanupConfirmed = false;
    await invalidateAll();
  });
}
</script>

<svelte:head>
  <title>Settings · Poyo Local Studio</title>
  <meta name="description" content="Configure local Poyo Studio behavior and privacy." />
</svelte:head>

<div class="route-shell">
  <div class="grid gap-8 lg:grid-cols-[13.75rem_minmax(0,48rem)]">
    <SettingsNavigation current="/settings" />

    <section aria-labelledby="settings-heading">
      <p class="eyebrow-label">Local configuration</p>
      <h2 id="settings-heading" class="mt-1 text-xl font-semibold tracking-tight">Studio operations</h2>
      <p class="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
        Environment configuration is authoritative. Secrets and filesystem operations remain on the loopback server.
      </p>
      <div class="mt-3">
        <button onclick={rerunSetup} disabled={pending !== null} class="focus-ring inline-flex min-h-8 items-center gap-1.5 rounded border border-border px-3 text-xs font-semibold disabled:opacity-50">
          <AppIcon name="sparkles" size={14} /> Re-run first-run setup
        </button>
      </div>

      {#if message}<p class="mt-4 rounded border border-success/30 bg-success/10 px-4 py-3 text-sm" role="status">{message}</p>{/if}
      {#if errorMessage}<p class="mt-4 rounded border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert">{errorMessage}</p>{/if}

      <div class="mt-6 divide-y divide-border border-y border-border">
        <section id="api" class="py-6" aria-labelledby="api-heading">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div><div class="flex flex-wrap items-center gap-2"><h3 id="api-heading" class="section-heading">Poyo API access</h3><Badge tone={settings.apiKey.status === 'configured' ? 'success' : 'warning'}>{keyState.label}</Badge></div><p class="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{keyState.detail} No masked fragment or key value is returned to the browser.</p></div>
            <AppIcon name="shield" size={21} class="text-muted-foreground" />
          </div>
          <dl class="mt-4 grid gap-3 text-xs sm:grid-cols-3"><div><dt class="text-muted-foreground">Selected local backend</dt><dd class="mt-1 font-semibold">{credentialState.selected}</dd></div><div><dt class="text-muted-foreground">Effective credential</dt><dd class="mt-1 font-semibold">{credentialState.effective}</dd></div><div><dt class="text-muted-foreground">Last key change</dt><dd class="mt-1 font-semibold">{settings.apiKey.updatedAt ? dateTimeLabel(settings.apiKey.updatedAt) : 'Never'}</dd></div></dl>
          {#if credentialState.transition}<p class="mt-3 rounded border border-warning/30 bg-warning/10 px-3 py-2 text-xs" role={credentialState.conflict ? 'alert' : 'status'}>{credentialState.transition}</p>{/if}
          {#if credentialState.conflict}
            <div class="mt-3 flex flex-wrap gap-2">
              {#if credentialState.actions.includes('abandon')}<button onclick={() => resolveCredentialConflict('abandon')} disabled={pending !== null} class="focus-ring min-h-9 rounded border border-border px-3 text-sm font-semibold disabled:opacity-50">Abandon stale move</button>{/if}
              {#if credentialState.actions.includes('resume-transition')}<button onclick={() => resolveCredentialConflict('resume-transition')} disabled={pending !== null} class="focus-ring min-h-9 rounded bg-primary px-3 text-sm font-semibold text-primary-foreground disabled:opacity-50">Resume verified move</button>{/if}
              {#if credentialState.actions.includes('retry-cleanup')}<button onclick={() => resolveCredentialConflict('retry-cleanup')} disabled={pending !== null} class="focus-ring min-h-9 rounded border border-border px-3 text-sm font-semibold disabled:opacity-50">Retry verified cleanup</button>{/if}
              {#if credentialState.actions.includes('acknowledge-retained-source')}<button onclick={() => resolveCredentialConflict('acknowledge-retained-source')} disabled={pending !== null} class="focus-ring min-h-9 rounded border border-border px-3 text-sm font-semibold disabled:opacity-50">Keep previous copy</button>{/if}
              {#if credentialState.actions.includes('reauthorize-replacement')}<button onclick={() => resolveCredentialConflict('reauthorize-replacement')} disabled={pending !== null} class="focus-ring min-h-9 rounded bg-primary px-3 text-sm font-semibold text-primary-foreground disabled:opacity-50">Re-authorize against current destination</button>{/if}
            </div>
          {/if}
          <div class="mt-5 border-t border-border pt-4">
            <div class="flex flex-wrap items-center justify-between gap-2"><h4 class="text-xs font-semibold">Local credential storage</h4>{#if settings.apiKey.environmentManaged}<Badge tone="neutral">Environment managed</Badge>{/if}</div>
            {#if settings.apiKey.environmentManaged}
              <p class="mt-2 text-xs leading-5 text-muted-foreground"><span class="font-mono">POYO_API_KEY</span> is authoritative. The selected local backend remains visible but inactive, and local changes are disabled.</p>
              <fieldset class="mt-3" disabled>
                <legend class="sr-only">Local credential backend</legend>
                <div class="grid gap-2 sm:grid-cols-2">
                  <label class="flex cursor-not-allowed items-start gap-3 rounded border border-border p-3 opacity-60"><input class="mt-0.5 size-4" type="radio" name="settings-credential-backend-environment" value="file" checked={settings.apiKey.selectedBackend === 'file'} /><span><strong class="text-sm">Permission-protected file (default)</strong><span class="mt-1 block text-xs leading-5 text-muted-foreground">Inactive while the environment key is effective.</span></span></label>
                  <label class="flex cursor-not-allowed items-start gap-3 rounded border border-border p-3 opacity-60"><input class="mt-0.5 size-4" type="radio" name="settings-credential-backend-environment" value="os" checked={settings.apiKey.selectedBackend === 'os'} /><span><strong class="text-sm">Operating-system store</strong><span class="mt-1 block text-xs leading-5 text-muted-foreground">Inactive while the environment key is effective.</span></span></label>
                </div>
              </fieldset>
            {:else}
              <fieldset class="mt-3" disabled={pending !== null || !settings.apiKey.localMutationAvailable}>
                <legend class="sr-only">Local credential backend</legend>
                <div class="grid gap-2 sm:grid-cols-2">
                  <label class="focus-within:ring-2 focus-within:ring-ring flex cursor-pointer items-start gap-3 rounded border border-border p-3"><input class="mt-0.5 size-4" type="radio" name="settings-credential-backend" value="file" bind:group={credentialChoice} /><span><strong class="text-sm">Permission-protected file (default)</strong><span class="mt-1 block text-xs leading-5 text-muted-foreground">Stored inside the selected Studio data root with private permissions.</span></span></label>
                  <label class="focus-within:ring-2 focus-within:ring-ring flex cursor-pointer items-start gap-3 rounded border border-border p-3 {settings.apiKey.backendAvailability.os === 'unavailable' ? 'cursor-not-allowed opacity-60' : ''}"><input class="mt-0.5 size-4" type="radio" name="settings-credential-backend" value="os" bind:group={credentialChoice} disabled={settings.apiKey.backendAvailability.os === 'unavailable'} /><span><strong class="text-sm">Operating-system store</strong><span class="mt-1 block text-xs leading-5 text-muted-foreground">macOS Keychain when supported. Availability is checked only after explicit selection.</span></span></label>
                </div>
              </fieldset>
              {#if credentialChoice !== settings.apiKey.selectedBackend}
                {#if !keyState.canConfigure}
                  <label class="mt-3 block max-w-xl text-xs font-semibold" for="backend-api-key">Poyo API key for the selected backend<input id="backend-api-key" type="password" bind:value={apiKeyInput} autocomplete="off" spellcheck="false" class="focus-ring mt-1.5 h-10 w-full rounded border border-input bg-background px-3 text-sm" placeholder="Temporary entry — never displayed again" /></label>
                {/if}
                <label class="mt-3 flex items-start gap-2 text-xs leading-5"><input class="focus-ring mt-0.5 size-4" type="checkbox" bind:checked={replaceExistingCredential} />Allow replacement only if a different key already exists in the selected destination.</label>
                <button onclick={switchCredentialBackend} disabled={pending !== null || (settings.apiKey.status !== 'configured' && !apiKeyInput.trim())} class="focus-ring mt-3 min-h-9 rounded border border-border px-3 text-sm font-semibold disabled:opacity-50">{pending === 'credential-backend' ? 'Moving securely…' : 'Move key to selected storage'}</button>
              {/if}
              {#if settings.apiKey.backendAvailability.os === 'unavailable'}<p class="mt-2 text-xs text-warning" role="status">The operating-system credential store is unavailable in this runtime. The file backend remains selected unless a supported store is explicitly available.</p>{/if}
            {/if}
          </div>
          {#if keyState.canConfigure}
            <form onsubmit={configureApiKey} class="mt-5 max-w-xl">
              <label for="local-api-key" class="text-xs font-semibold">{settings.apiKey.source === 'local' ? 'Replace local key' : 'Add a local server-side key'}</label>
              <p class="mt-1 text-xs leading-5 text-muted-foreground">Environment configuration remains preferred. This field is cleared immediately after submission and is never stored in browser storage.</p>
              <div class="mt-2 flex flex-col gap-2 sm:flex-row"><input id="local-api-key" type="password" bind:value={apiKeyInput} autocomplete="off" spellcheck="false" class="focus-ring h-10 min-w-0 flex-1 rounded border border-input bg-background px-3 text-sm" placeholder="Temporary entry — never displayed again" /><button type="submit" disabled={pending !== null || !apiKeyInput.trim()} class="focus-ring min-h-10 rounded bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50">Store locally</button></div>
            </form>
          {/if}
          <div class="mt-5 flex flex-wrap items-center gap-2"><button onclick={testConnectivity} disabled={pending !== null || !keyState.canTest} class="focus-ring inline-flex min-h-9 items-center gap-2 rounded border border-border px-3 text-sm font-semibold disabled:opacity-50"><AppIcon name="wifi" size={15} /> Test connection</button>{#if keyState.canRemove}<button onclick={removeApiKey} disabled={pending !== null} class="focus-ring min-h-9 rounded border border-destructive/40 px-3 text-sm font-semibold text-destructive">Remove local key</button>{/if}<span class="text-xs text-muted-foreground">{connectivity.checkedAt ? `${connectivity.status === 'ok' ? 'Passed' : 'Failed'} ${dateTimeLabel(connectivity.checkedAt)}` : 'Not checked'}{account ? ` · ${account}` : ''}</span></div>
        </section>

        <section id="storage" class="py-6" aria-labelledby="storage-heading">
          <div class="flex flex-wrap items-start justify-between gap-4"><div><h3 id="storage-heading" class="section-heading">Storage and downloads</h3><p class="mt-2 text-sm leading-6 text-muted-foreground">The default keeps all Studio-managed data in <span class="font-mono">./data</span>. Platform application storage is an explicit opt-in, and media remains indefinitely unless a cleanup policy is saved and confirmed.</p></div><Badge tone="neutral">{storageRoot.state === 'environment-managed' ? 'Environment managed' : storageRoot.state === 'restart-required' ? 'Restart required' : storageRoot.state === 'cleanup-pending' ? 'Source retained' : 'Active'}</Badge></div>
          <dl class="mt-4 grid gap-3 text-xs sm:grid-cols-2"><div><dt class="text-muted-foreground">Indexed media</dt><dd class="mt-1 font-semibold">{byteSizeLabel(data.storage.indexedBytes)} · {data.storage.verifiedFiles} verified files</dd></div><div><dt class="text-muted-foreground">Disk free</dt><dd class="mt-1 font-semibold">{data.storage.freeBytes === null ? 'Unavailable' : byteSizeLabel(data.storage.freeBytes)}</dd></div></dl>
          <div class="mt-5 border-t border-border pt-4">
            <h4 class="text-xs font-semibold">Application data location</h4>
            <dl class="mt-3 grid gap-3 text-xs sm:grid-cols-3"><div><dt class="text-muted-foreground">Current</dt><dd class="mt-1 font-semibold">{storageRoot.current.label}</dd></div><div><dt class="text-muted-foreground">Selected</dt><dd class="mt-1 font-semibold">{storageRoot.selected.label}</dd></div><div><dt class="text-muted-foreground">Effective</dt><dd class="mt-1 font-semibold">{storageRoot.effective.label}</dd></div></dl>
            <p class="mt-3 rounded bg-muted px-3 py-2 text-xs leading-5 text-muted-foreground">{rootState.detail} {rootState.retention}</p>
            {#if storageRoot.exclusions.length > 0}
              <p class="mt-3 rounded border border-border px-3 py-2 text-xs leading-5 text-muted-foreground">
                This move covers root-owned Studio data only. {rootState.exclusionSummary}
              </p>
            {/if}
            {#if storageRoot.environmentManaged}
              <p class="mt-3 text-xs leading-5 text-muted-foreground"><span class="font-mono">PLS_APP_DATA_DIR</span> controls the root. In-app changes are disabled.</p>
              <fieldset class="mt-3" disabled>
                <legend class="sr-only">Application data location</legend>
                <div class="grid gap-2 sm:grid-cols-2">
                  {#each storageRoot.choices as choice (choice.kind)}
                    <label class="flex cursor-not-allowed items-start gap-3 rounded border border-border p-3 opacity-60"><input class="mt-0.5 size-4" type="radio" name="settings-storage-root-environment" value={choice.kind} /><span><strong class="text-sm">{choice.label}{choice.kind === 'project' ? ' (default)' : ''}</strong><span class="mt-1 block font-mono text-xs text-muted-foreground">{choice.location}</span></span></label>
                  {/each}
                </div>
              </fieldset>
            {:else if storageRoot.restartRequired}
              <p class="mt-3 rounded border border-warning/30 bg-warning/10 px-3 py-2 text-xs" role="status">
                {storageRoot.selected.kind === storageRoot.current.kind
                  ? 'Restart the Studio before making more local changes. This process is safely frozen.'
                  : `Restart the Studio to verify and activate ${storageRoot.selected.label}. Writes are frozen, and root-owned source data is retained until verification succeeds.`}
              </p>
            {:else}
              <fieldset class="mt-3" disabled={pending !== null || !storageRoot.mutationAvailable}>
                <legend class="sr-only">Application data location</legend>
                <div class="grid gap-2 sm:grid-cols-2">
                  {#each storageRoot.choices as choice (choice.kind)}
                    <label class="focus-within:ring-2 focus-within:ring-ring flex cursor-pointer items-start gap-3 rounded border border-border p-3"><input class="mt-0.5 size-4" type="radio" name="settings-storage-root" value={choice.kind} checked={rootChoice === choice.kind} onchange={() => { if (choice.kind !== 'environment') rootChoice = choice.kind; }} /><span><strong class="text-sm">{choice.label}{choice.kind === 'project' ? ' (default)' : ''}</strong><span class="mt-1 block font-mono text-xs text-muted-foreground">{choice.location}</span></span></label>
                  {/each}
                </div>
              </fieldset>
              <button onclick={relocateStorageRoot} disabled={pending !== null || rootChoice === storageRoot.current.kind || !storageRoot.mutationAvailable} class="focus-ring mt-3 min-h-9 rounded border border-border px-3 text-sm font-semibold disabled:opacity-50">{pending === 'storage-root' ? 'Copying and verifying…' : storageRoot.exclusions.length > 0 ? 'Move all root-owned Studio data' : 'Move all Studio data'}</button>
            {/if}
          </div>
          <div class="mt-5 border-t border-border pt-4">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <h4 class="text-xs font-semibold">Output location</h4>
              {#if outputLocation.environmentManaged}<Badge tone="neutral">Environment managed</Badge>{:else if outputLocation.configured}<Badge tone="info">Custom folder</Badge>{/if}
            </div>
            <p class="mt-1 text-xs leading-5 text-muted-foreground">Generated media is written here. Existing outputs stay readable when the location changes; a change applies to new outputs after the next restart.</p>
            <p class="mt-2 break-all rounded bg-muted px-3 py-2 font-mono text-[0.6875rem]">{outputLocation.active}{#if outputLocation.pending} → {outputLocation.pending} <span class="text-warning">(after restart)</span>{/if}</p>
            {#if outputLocation.environmentManaged}
              <p class="mt-2 text-xs text-muted-foreground">Controlled by the <span class="font-mono">PLS_MEDIA_DIR</span> environment variable.</p>
            {:else}
              <div class="mt-2 flex flex-col gap-2 sm:flex-row">
                <input bind:value={directoryInput} spellcheck="false" autocomplete="off" placeholder="/absolute/path/to/folder" aria-label="Custom output folder" class="focus-ring h-9 min-w-0 flex-1 rounded border border-input bg-background px-3 font-mono text-xs" />
                <button onclick={checkOutputDirectory} disabled={pending !== null || !directoryInput.trim()} class="focus-ring min-h-9 rounded border border-border px-3 text-xs font-semibold disabled:opacity-50">Check</button>
                <button onclick={saveOutputDirectory} disabled={pending !== null || !directoryCheck?.ok} class="focus-ring min-h-9 rounded bg-primary px-3 text-xs font-semibold text-primary-foreground disabled:opacity-50">Save</button>
                {#if outputLocation.configured}<button onclick={resetOutputDirectory} disabled={pending !== null} class="focus-ring min-h-9 rounded border border-border px-3 text-xs font-semibold">Reset to default</button>{/if}
              </div>
              {#if directoryCheck}<p class="mt-1.5 text-xs {directoryCheck.ok ? 'text-success' : 'text-destructive'}" role="status">{directoryCheck.message}</p>{/if}
            {/if}
          </div>
          <label class="mt-5 flex items-start gap-3 text-sm"><input type="checkbox" bind:checked={draft.automaticDownloads} class="focus-ring mt-0.5 size-4" /><span><strong>Download successful outputs automatically</strong><span class="mt-1 block text-xs leading-5 text-muted-foreground">Recommended because remote retention is not documented.</span></span></label>
        </section>

        <section id="jobs" class="py-6" aria-labelledby="jobs-heading">
          <h3 id="jobs-heading" class="section-heading">Polling and recovery</h3><p class="mt-2 text-sm leading-6 text-muted-foreground">These values control normal status cadence and when interrupted work is marked stale. Retry-After and bounded exponential backoff still take precedence after failures.</p>
          <div class="mt-4 grid gap-4 sm:grid-cols-2"><label class="text-xs font-semibold">Polling interval (seconds)<input type="number" min="1" max="300" step="1" bind:value={draft.pollingSeconds} class="focus-ring mt-1.5 h-10 w-full rounded border border-input bg-background px-3 text-sm" /></label><label class="text-xs font-semibold">Stale threshold (minutes)<input type="number" min="1" max="10080" step="1" bind:value={draft.staleMinutes} class="focus-ring mt-1.5 h-10 w-full rounded border border-input bg-background px-3 text-sm" /></label></div>
        </section>

        <section id="cleanup" class="py-6" aria-labelledby="cleanup-heading">
          <div class="flex flex-wrap items-start justify-between gap-4"><div><h3 id="cleanup-heading" class="section-heading">Local retention and cleanup</h3><p class="mt-2 text-sm leading-6 text-muted-foreground">Cleanup is opt-in. Saving a non-never policy enables periodic local evaluation with the selected deletion consequence; preview and confirmation can run the current candidates immediately.</p></div><Badge tone={draft.cleanupMode === 'never' ? 'success' : 'warning'}>{draft.cleanupMode === 'never' ? 'Never delete automatically' : 'Opt-in policy'}</Badge></div>
          <label class="mt-4 block text-xs font-semibold">Policy<select bind:value={draft.cleanupMode} onchange={clearPreview} class="focus-ring mt-1.5 h-10 w-full rounded border border-input bg-background px-3 text-sm"><option value="never">Never delete automatically</option><option value="age">Files older than an age</option><option value="total-size">Limit indexed media size</option><option value="min-free-space">Maintain free disk space</option></select></label>
          {#if draft.cleanupMode === 'age'}<label class="mt-3 block text-xs font-semibold">Delete files older than (days)<input type="number" min="1" max="36500" bind:value={draft.olderThanDays} oninput={clearPreview} class="focus-ring mt-1.5 h-10 w-full rounded border border-input bg-background px-3 text-sm" /></label>{:else if draft.cleanupMode === 'total-size'}<label class="mt-3 block text-xs font-semibold">Maximum indexed media (GB)<input type="number" min="0.01" step="0.1" bind:value={draft.maxStorageGb} oninput={clearPreview} class="focus-ring mt-1.5 h-10 w-full rounded border border-input bg-background px-3 text-sm" /></label>{:else if draft.cleanupMode === 'min-free-space'}<label class="mt-3 block text-xs font-semibold">Minimum free disk space (GB)<input type="number" min="0.01" step="0.1" bind:value={draft.minFreeGb} oninput={clearPreview} class="focus-ring mt-1.5 h-10 w-full rounded border border-input bg-background px-3 text-sm" /></label>{/if}
          <fieldset class="mt-4"><legend class="text-xs font-semibold">Always exclude</legend><div class="mt-2 flex flex-wrap gap-4 text-sm"><label class="flex items-center gap-2"><input type="checkbox" bind:checked={draft.excludeFavorites} onchange={clearPreview} class="focus-ring size-4" /> Favorites</label><label class="flex items-center gap-2"><input type="checkbox" bind:checked={draft.excludePinned} onchange={clearPreview} class="focus-ring size-4" /> Pinned outputs</label></div><label class="mt-3 block text-xs font-semibold">Excluded tags<input bind:value={draft.excludedTags} oninput={clearPreview} class="focus-ring mt-1.5 h-10 w-full rounded border border-input bg-background px-3 text-sm" placeholder="client-work, archive" /></label></fieldset>
          <div class="mt-5 border-t border-border pt-4"><label class="block text-xs font-semibold">Deletion consequence<select bind:value={consequence} onchange={clearPreview} class="focus-ring mt-1.5 h-10 w-full rounded border border-input bg-background px-3 text-sm"><option value="file">Files only</option><option value="metadata">Metadata only</option><option value="both">Files and metadata</option></select></label><p class="mt-2 text-xs leading-5 text-warning">{cleanupConsequenceLabel(consequence)}</p><button onclick={previewCleanup} disabled={pending !== null} class="focus-ring mt-3 min-h-9 rounded border border-border px-3 text-sm font-semibold">Save automatic policy and preview</button></div>
          {#if preview}<div class="mt-5 rounded border border-border bg-muted/50 p-4"><div class="flex flex-wrap items-start justify-between gap-3"><div><p class="text-sm font-semibold">Preview: {preview.candidates.length} candidates · {byteSizeLabel(preview.totalBytes)}</p><p class="mt-1 text-xs text-muted-foreground">Created {dateTimeLabel(preview.createdAt)}. The scheduler revalidates the saved policy and candidates before each durable action.</p></div><Badge tone={preview.candidates.length ? 'warning' : 'success'}>{preview.candidates.length ? 'Immediate run optional' : 'Nothing selected'}</Badge></div>{#if preview.candidates.length}<ul class="mt-4 max-h-52 space-y-2 overflow-auto border-y border-border py-3">{#each preview.candidates as candidate}<li class="grid gap-1 text-xs sm:grid-cols-[minmax(0,1fr)_auto]"><span class="truncate font-semibold">{candidate.fileName}</span><span>{byteSizeLabel(candidate.bytes)}</span><span class="text-muted-foreground sm:col-span-2">{candidate.mediaKind} · {candidate.reasons.join(', ')}</span></li>{/each}</ul><label class="mt-4 flex items-start gap-3 text-sm"><input type="checkbox" bind:checked={cleanupConfirmed} class="focus-ring mt-0.5 size-4" /><span>Run these current candidates now with the saved local consequence. This does not delete anything from Poyo.</span></label><button onclick={applyCleanup} disabled={pending !== null || !cleanupConfirmed} class="focus-ring mt-3 min-h-9 rounded bg-destructive px-3 text-sm font-semibold text-destructive-foreground disabled:opacity-50">Run current cleanup now</button>{/if}</div>{/if}
        </section>

        <section id="remote-cleanup" class="py-6" aria-labelledby="remote-heading"><div class="flex flex-wrap items-center gap-2"><h3 id="remote-heading" class="section-heading">Remote Poyo cleanup</h3><Badge tone="neutral">Unavailable</Badge></div><p class="mt-2 text-sm leading-6 text-muted-foreground">{settings.remoteCleanup.reason} Verified {settings.remoteCleanup.verifiedAt}. No toggle, schedule, or simulated remote deletion is available.</p></section>

        <section id="logging" class="py-6" aria-labelledby="logging-heading"><h3 id="logging-heading" class="section-heading">Structured log rotation</h3><p class="mt-2 text-sm leading-6 text-muted-foreground">Logs are local JSONL, redact secret-like values, and use bounded size, age, and retained-file limits.</p><div class="mt-4 grid gap-4 sm:grid-cols-2"><label class="text-xs font-semibold">Rotate at size (MB)<input type="number" min="0.0625" max="1024" step="0.25" bind:value={draft.logSizeMb} class="focus-ring mt-1.5 h-10 w-full rounded border border-input bg-background px-3 text-sm" /></label><label class="text-xs font-semibold">Rotate at age (hours)<input type="number" min="0.0167" max="720" step="1" bind:value={draft.logAgeHours} class="focus-ring mt-1.5 h-10 w-full rounded border border-input bg-background px-3 text-sm" /></label><label class="text-xs font-semibold">Retention (days)<input type="number" min="0.0417" max="365" step="1" bind:value={draft.logRetentionDays} class="focus-ring mt-1.5 h-10 w-full rounded border border-input bg-background px-3 text-sm" /></label><label class="text-xs font-semibold">Maximum rotated files<input type="number" min="1" max="100" bind:value={draft.maxRotatedFiles} class="focus-ring mt-1.5 h-10 w-full rounded border border-input bg-background px-3 text-sm" /></label></div><label class="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" bind:checked={draft.separateErrorFile} class="focus-ring size-4" /> Keep a separate error stream</label></section>

        <section id="appearance" class="py-6" aria-labelledby="appearance-heading"><h3 id="appearance-heading" class="section-heading">Appearance</h3><p class="mt-2 text-sm leading-6 text-muted-foreground">Light remains the product default. Save a local installation preference and use the adjacent control to cycle this browser immediately.</p><div class="mt-4 flex flex-wrap items-center gap-2"><label class="text-xs font-semibold">Default mode<select bind:value={draft.theme} class="focus-ring ml-2 h-9 rounded border border-input bg-background px-3 text-sm"><option value="light">Light</option><option value="dark">Dark</option><option value="system">System</option></select></label><ThemeToggle class="border border-border bg-background" /></div></section>

        <section id="registry" class="py-6" aria-labelledby="registry-heading"><h3 id="registry-heading" class="section-heading">Registry and versions</h3><p class="mt-2 text-sm leading-6 text-muted-foreground">The local audited registry is seeded into SQLite at startup.</p><dl class="mt-4 grid gap-3 text-xs sm:grid-cols-3"><div><dt class="text-muted-foreground">Application</dt><dd class="mt-1 font-mono font-semibold">{data.versions.application}</dd></div><div><dt class="text-muted-foreground">Database schema</dt><dd class="mt-1 font-mono font-semibold">{data.versions.databaseSchema}</dd></div><div><dt class="text-muted-foreground">Registry schema</dt><dd class="mt-1 font-mono font-semibold">{data.versions.registrySchema}</dd></div></dl><ul class="mt-4 divide-y divide-border border-y border-border">{#each data.registry as registry}<li class="grid gap-1 py-3 text-xs sm:grid-cols-[minmax(0,1fr)_auto_auto]"><span class="font-mono font-semibold">{registry.version}</span><span>{registry.status}</span><time class="text-muted-foreground" datetime={registry.verifiedAt}>{dateTimeLabel(registry.verifiedAt)}</time></li>{/each}</ul></section>
      </div>

      <div class="sticky bottom-16 z-10 mt-5 flex flex-wrap items-center justify-between gap-3 rounded border border-border bg-background/95 p-2.5 shadow-[var(--shadow-md)] backdrop-blur sm:p-3 lg:bottom-4"><p class="hidden text-xs text-muted-foreground sm:block">Saves polling, download, logging, and default theme settings. Cleanup policy is saved by its preview action.</p><button onclick={saveOperations} disabled={pending !== null} class="focus-ring min-h-10 w-full rounded bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50 sm:w-auto">{pending === 'operations' ? 'Saving…' : 'Save operational settings'}</button></div>
    </section>
  </div>
</div>
