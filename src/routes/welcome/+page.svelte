<script lang="ts">
import { untrack } from 'svelte';
import { goto } from '$app/navigation';
import AppIcon from '$lib/components/ui/AppIcon.svelte';
import Badge from '$lib/components/ui/Badge.svelte';
import Button from '$lib/components/ui/Button.svelte';
import type {
  OnboardingStateDto,
  SettingsDto,
  StorageRootSettingsDto
} from '$lib/features/settings/contracts';
import {
  apiKeyUiState,
  credentialBackendLabel,
  credentialBackendUiState,
  operationsRequest,
  settingsDraft,
  storageRootUiState
} from '$lib/features/settings/controller';
import { resolveTheme, themePreferences, themeStorageKey, type ThemePreference } from '$lib/theme';
import type { PageData } from './$types';

let { data }: { data: PageData } = $props();
const initial = untrack(() => data);

const steps = ['intro', 'location', 'apiKey', 'theme', 'done'] as const;
type Step = (typeof steps)[number];

let settings = $state<SettingsDto>(initial.settings);
let storageRoot = $state<StorageRootSettingsDto>(initial.storageRoot);
let onboarding = $state<OnboardingStateDto>(initial.onboarding);

// Resume at the first incomplete stage so a reload does not restart the flow.
function firstIncompleteStep(state: OnboardingStateDto): Step {
  const { location, connection, theme } = state.steps;
  // A brand-new install (nothing done yet) starts on the intro; a reload mid-flow resumes at the
  // first incomplete step, and a fully-complete state resumes on the final screen.
  if (!location && !connection && !theme) return 'intro';
  if (!location) return 'location';
  if (!connection) return 'apiKey';
  if (!theme) return 'theme';
  return 'done';
}

let step = $state<Step>(untrack(() => firstIncompleteStep(initial.onboarding)));
let busy = $state(false);
let message = $state('');
let errorMessage = $state('');

let rootChoice = $state<'project' | 'platform'>(
  initial.storageRoot.selected.kind === 'platform' ? 'platform' : 'project'
);

let apiKeyInput = $state('');
let credentialChoice = $state<'file' | 'os'>(initial.settings.apiKey.selectedBackend);
let replaceExistingCredential = $state(false);
let connectivityLabel = $state('');

let themeChoice = $state<ThemePreference>(untrack(() => initial.settings.theme.defaultMode));

let heading = $state<HTMLHeadingElement | null>(null);
let keyState = $derived(apiKeyUiState(settings.apiKey));
let credentialState = $derived(credentialBackendUiState(settings.apiKey));
let rootState = $derived(storageRootUiState(storageRoot));
let selectedRootChoice = $derived(
  storageRoot.choices.find((choice) => choice.kind === rootChoice) ?? storageRoot.choices[0]
);
let stepIndex = $derived(steps.indexOf(step));

$effect(() => {
  step;
  heading?.focus();
});

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

async function run(callback: () => Promise<void>): Promise<void> {
  busy = true;
  message = '';
  errorMessage = '';
  try {
    await callback();
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'The local operation failed.';
  } finally {
    busy = false;
  }
}

function goToStep(next: Step): void {
  message = '';
  errorMessage = '';
  step = next;
}

function next(): void {
  const target = steps[Math.min(stepIndex + 1, steps.length - 1)];
  if (target) goToStep(target);
}

function back(): void {
  const target = steps[Math.max(stepIndex - 1, 0)];
  if (target) goToStep(target);
}

async function markStep(patch: Partial<OnboardingStateDto['steps']>): Promise<void> {
  const result = await request<{ onboarding: OnboardingStateDto }>('/api/onboarding', 'PUT', {
    steps: patch
  });
  onboarding = result.onboarding;
}

function applyStorageRoot(): void {
  void run(async () => {
    if (storageRoot.environmentManaged || rootChoice === storageRoot.current.kind) {
      await markStep({ location: true });
      next();
      return;
    }
    const result = await request<{ storageRoot: StorageRootSettingsDto }>(
      '/api/settings/storage-root',
      'POST',
      { targetRootKind: rootChoice }
    );
    storageRoot = result.storageRoot;
    message = `${result.storageRoot.selected.label} is selected. Restart the Studio to verify and activate the copied data, then continue setup.`;
  });
}

function saveApiKey(event: SubmitEvent): void {
  event.preventDefault();
  if (!settings.apiKey.localMutationAvailable) return;
  const switching = credentialChoice !== settings.apiKey.selectedBackend;
  if (!switching && !apiKeyInput.trim()) return;
  void run(async () => {
    try {
      const result = switching
        ? await request<{ apiKey: SettingsDto['apiKey'] }>(
            '/api/settings/credential-backend',
            'POST',
            {
              backend: credentialChoice,
              ...(apiKeyInput.trim() ? { apiKey: apiKeyInput } : {}),
              replaceExisting: replaceExistingCredential
            }
          )
        : await request<{ apiKey: SettingsDto['apiKey'] }>('/api/settings/api-key', 'PUT', {
            apiKey: apiKeyInput
          });
      settings = { ...settings, apiKey: result.apiKey };
      credentialChoice = result.apiKey.selectedBackend;
      replaceExistingCredential = false;
      message = switching
        ? result.apiKey.transition
          ? `Key moved to ${credentialBackendLabel(result.apiKey.selectedBackend)}. The target is authoritative; the previous copy is retained pending cleanup.`
          : `Key moved to ${credentialBackendLabel(result.apiKey.selectedBackend)} and verified before the previous copy was removed.`
        : 'Key stored by the local server only. Its value never returns to this page.';
    } finally {
      apiKeyInput = '';
    }
  });
}

function resolveCredentialConflict(
  action: NonNullable<SettingsDto['apiKey']['transition']>['actions'][number]
): void {
  void run(async () => {
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

function testConnectivity(): void {
  void run(async () => {
    const result = await request<{ connectivity: { status: string; account: string | null } }>(
      '/api/settings/api-key/connectivity',
      'POST',
      {}
    );
    connectivityLabel =
      result.connectivity.status === 'ok'
        ? `Connected${result.connectivity.account ? ` · ${result.connectivity.account}` : ''}`
        : 'Connection failed';
  });
}

function completeApiKeyStep(): void {
  void run(async () => {
    await markStep({ connection: true });
    next();
  });
}

function applyTheme(choice: ThemePreference): void {
  themeChoice = choice;
  // Storage/matchMedia access can throw (private mode, disabled storage); mirror the studio-draft
  // convention and degrade gracefully so a theme click never breaks the onboarding page.
  try {
    localStorage.setItem(themeStorageKey, choice);
    const resolved = resolveTheme(
      choice,
      window.matchMedia('(prefers-color-scheme: dark)').matches
    );
    document.documentElement.classList.toggle('dark', resolved === 'dark');
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePreference = choice;
  } catch {
    // Ignore storage/matchMedia failures; the selected theme is still persisted via saveTheme().
  }
}

function saveTheme(): void {
  void run(async () => {
    const draft = { ...settingsDraft(settings), theme: themeChoice };
    const result = await request<{ settings: SettingsDto }>('/api/settings', 'PUT', {
      operations: operationsRequest(draft)
    });
    settings = result.settings;
    await markStep({ theme: true });
    next();
    // Set the confirmation after advancing so goToStep() does not clear it before it renders.
    message = 'Appearance saved.';
  });
}

function finish(): void {
  void run(async () => {
    await request('/api/onboarding', 'PUT', {
      complete: true,
      steps: { location: true, connection: true, theme: true, defaults: true }
    });
    await goto('/');
  });
}

const themeLabels: Record<ThemePreference, string> = {
  system: 'Match system',
  light: 'Light',
  dark: 'Dark'
};
const stepTitles: Record<Step, string> = {
  intro: 'Welcome to Poyo Local Studio',
  location: 'Where should Studio data live?',
  apiKey: 'Connect your Poyo API key',
  theme: 'Choose your appearance',
  done: 'You are ready to create'
};
</script>

<svelte:head>
  <title>Welcome · Poyo Local Studio</title>
  <meta name="description" content="Set up Poyo Local Studio for first use." />
</svelte:head>

<div class="mx-auto flex min-h-[80vh] w-full max-w-2xl flex-col px-4 py-8 sm:py-12">
  <header>
    <p class="eyebrow-label">First-run setup</p>
    <ol class="mt-3 flex flex-wrap gap-2" aria-label="Setup progress">
      {#each steps.slice(0, 4) as label, index (label)}
        <li
          class="flex min-h-6 items-center gap-1.5 rounded-full border px-2.5 text-[0.6875rem] font-semibold {index <
          stepIndex
            ? 'border-success/40 bg-success/10 text-foreground'
            : index === stepIndex
              ? 'border-primary bg-primary/10 text-foreground'
              : 'border-border text-muted-foreground'}"
          aria-current={index === stepIndex ? 'step' : undefined}
        >
          <span class="tabular-nums">{index + 1}</span>
          <span class="capitalize">{label === 'apiKey' ? 'API key' : label}</span>
        </li>
      {/each}
    </ol>
  </header>

  <div
    class="mt-5 flex-1 overflow-hidden rounded-lg border border-border bg-card p-6 shadow-[var(--shadow-xs)]"
  >
    <h1 bind:this={heading} tabindex="-1" class="text-xl font-semibold tracking-tight focus:outline-none">
      {stepTitles[step]}
    </h1>

    {#if message}
      <p class="mt-4 rounded border border-success/30 bg-success/10 px-4 py-3 text-sm" role="status">
        {message}
      </p>
    {/if}
    {#if errorMessage}
      <p
        class="mt-4 rounded border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        role="alert"
      >
        {errorMessage}
      </p>
    {/if}

    {#if step === 'intro'}
      <p class="mt-3 text-sm leading-6 text-muted-foreground">
        This local studio creates images and video through Poyo and keeps everything on this machine.
        We will choose where root-owned Studio data and the API key live, then set the appearance. The
        project data folder and permission-protected key file are the defaults; platform storage is
        always an explicit choice.
      </p>
      <ul class="mt-4 grid gap-2 text-sm">
        <li class="flex items-center gap-2"><AppIcon name="shield" size={16} class="text-muted-foreground" /> Keys stay on the loopback server, never in the browser.</li>
        <li class="flex items-center gap-2"><AppIcon name="sparkles" size={16} class="text-muted-foreground" /> Storage moves retain the source until the copy is verified after restart.</li>
      </ul>
    {:else if step === 'location'}
      <p class="mt-3 text-sm leading-6 text-muted-foreground">
        The default keeps root-owned database, generated media, uploads, logs, and the local secret
        file inside this project. Platform application storage is optional.
      </p>
      <dl class="mt-4 grid gap-3 text-xs sm:grid-cols-3">
        <div><dt class="text-muted-foreground">Current</dt><dd class="mt-1 font-semibold">{storageRoot.current.label}</dd></div>
        <div><dt class="text-muted-foreground">Selected</dt><dd class="mt-1 font-semibold">{storageRoot.selected.label}</dd></div>
        <div><dt class="text-muted-foreground">Effective</dt><dd class="mt-1 font-semibold">{storageRoot.effective.label}</dd></div>
      </dl>
      <p class="mt-3 rounded bg-muted px-3 py-2 text-xs leading-5 text-muted-foreground">
        {rootState.detail} {rootState.retention}
      </p>
      {#if storageRoot.exclusions.length > 0}
        <p class="mt-3 rounded border border-border px-3 py-2 text-xs leading-5 text-muted-foreground">
          The choice moves root-owned Studio data only. {rootState.exclusionSummary}
        </p>
      {/if}
      {#if storageRoot.environmentManaged}
        <p class="mt-4 rounded border border-border bg-muted/60 px-4 py-3 text-sm text-muted-foreground">
          <span class="font-mono">PLS_APP_DATA_DIR</span> is authoritative. The in-app choices remain
          visible but cannot replace the environment override.
        </p>
        <fieldset class="mt-4" disabled>
          <legend class="text-xs font-semibold">Application data location</legend>
          <div class="mt-2 grid gap-2">
            {#each storageRoot.choices as choice (choice.kind)}
              <label class="flex cursor-not-allowed items-start gap-3 rounded border border-border p-3 opacity-60"><input class="mt-0.5 size-4" type="radio" name="storage-root-environment" value={choice.kind} /><span><strong class="text-sm">{choice.label}{choice.kind === 'project' ? ' (default)' : ''}</strong><span class="mt-1 block font-mono text-xs text-muted-foreground">{choice.location}</span></span></label>
            {/each}
          </div>
        </fieldset>
      {:else if storageRoot.restartRequired}
        <p class="mt-4 rounded border border-warning/30 bg-warning/10 px-4 py-3 text-sm" role="status">
          {storageRoot.selected.kind === storageRoot.current.kind
            ? 'Restart required. This process is safely frozen and accepts no new local changes.'
            : 'Restart required. Writes are frozen in this process, and root-owned source data remains retained until startup verification succeeds.'}
        </p>
      {:else}
        <fieldset class="mt-5" disabled={busy || !storageRoot.mutationAvailable}>
          <legend class="text-xs font-semibold">Application data location</legend>
          <div class="mt-2 grid gap-2">
            {#each storageRoot.choices as choice (choice.kind)}
              <label class="focus-within:ring-2 focus-within:ring-ring flex cursor-pointer items-start gap-3 rounded border border-border p-3">
                <input
                  class="mt-0.5 size-4"
                  type="radio"
                  name="storage-root"
                  value={choice.kind}
                  checked={rootChoice === choice.kind}
                  onchange={() => {
                    if (choice.kind !== 'environment') rootChoice = choice.kind;
                  }}
                />
                <span><strong class="text-sm">{choice.label}{choice.kind === 'project' ? ' (default)' : ''}</strong><span class="mt-1 block font-mono text-xs text-muted-foreground">{choice.location}</span></span>
              </label>
            {/each}
          </div>
        </fieldset>
        <p class="mt-3 text-xs leading-5 text-muted-foreground">
          Choosing {selectedRootChoice.label} moves {storageRoot.exclusions.length > 0
            ? 'all root-owned Studio data'
            : 'the complete local root'}. A different choice is copied and verified now, then
          activated only after restart.
        </p>
      {/if}
    {:else if step === 'apiKey'}
      <div class="mt-3 flex flex-wrap items-center gap-2">
        <Badge tone={settings.apiKey.status === 'configured' ? 'success' : 'warning'}>{keyState.label}</Badge>
        {#if connectivityLabel}<span class="text-xs text-muted-foreground">{connectivityLabel}</span>{/if}
      </div>
      <p class="mt-3 text-sm leading-6 text-muted-foreground">{keyState.detail}</p>
      <dl class="mt-4 grid gap-3 text-xs sm:grid-cols-2">
        <div><dt class="text-muted-foreground">Selected local backend</dt><dd class="mt-1 font-semibold">{credentialState.selected}</dd></div>
        <div><dt class="text-muted-foreground">Effective credential</dt><dd class="mt-1 font-semibold">{credentialState.effective}</dd></div>
      </dl>
      {#if credentialState.transition}
        <p class="mt-3 rounded border border-warning/30 bg-warning/10 px-3 py-2 text-xs" role={credentialState.conflict ? 'alert' : 'status'}>{credentialState.transition}</p>
      {/if}
      {#if credentialState.conflict}
        <div class="mt-3 flex flex-wrap gap-2">
          {#if credentialState.actions.includes('abandon')}<Button variant="outline" onclick={() => resolveCredentialConflict('abandon')} disabled={busy}>Abandon stale move</Button>{/if}
          {#if credentialState.actions.includes('resume-transition')}<Button variant="primary" onclick={() => resolveCredentialConflict('resume-transition')} disabled={busy}>Resume verified move</Button>{/if}
          {#if credentialState.actions.includes('retry-cleanup')}<Button variant="outline" onclick={() => resolveCredentialConflict('retry-cleanup')} disabled={busy}>Retry verified cleanup</Button>{/if}
          {#if credentialState.actions.includes('acknowledge-retained-source')}<Button variant="outline" onclick={() => resolveCredentialConflict('acknowledge-retained-source')} disabled={busy}>Keep previous copy</Button>{/if}
          {#if credentialState.actions.includes('reauthorize-replacement')}<Button variant="primary" onclick={() => resolveCredentialConflict('reauthorize-replacement')} disabled={busy}>Re-authorize against current destination</Button>{/if}
        </div>
      {/if}
      {#if settings.apiKey.environmentManaged}
        <p class="mt-4 rounded border border-border bg-muted/60 px-4 py-3 text-sm text-muted-foreground">
          <span class="font-mono">POYO_API_KEY</span> is authoritative. Local backend selection and
          key changes are disabled until the environment override is removed and the Studio restarts.
        </p>
        <fieldset class="mt-4" disabled>
          <legend class="text-xs font-semibold">Local credential backend</legend>
          <div class="mt-2 grid gap-2 sm:grid-cols-2">
            <label class="flex cursor-not-allowed items-start gap-3 rounded border border-border p-3 opacity-60"><input class="mt-0.5 size-4" type="radio" name="credential-backend-environment" value="file" checked={settings.apiKey.selectedBackend === 'file'} /><span><strong class="text-sm">Permission-protected file (default)</strong></span></label>
            <label class="flex cursor-not-allowed items-start gap-3 rounded border border-border p-3 opacity-60"><input class="mt-0.5 size-4" type="radio" name="credential-backend-environment" value="os" checked={settings.apiKey.selectedBackend === 'os'} /><span><strong class="text-sm">Operating-system store</strong></span></label>
          </div>
        </fieldset>
      {:else if settings.apiKey.localMutationAvailable}
        <fieldset class="mt-5" disabled={busy}>
          <legend class="text-xs font-semibold">Store the API key in</legend>
          <div class="mt-2 grid gap-2 sm:grid-cols-2">
            <label class="focus-within:ring-2 focus-within:ring-ring flex cursor-pointer items-start gap-3 rounded border border-border p-3">
              <input class="mt-0.5 size-4" type="radio" name="credential-backend" value="file" bind:group={credentialChoice} />
              <span><strong class="text-sm">Permission-protected file (default)</strong><span class="mt-1 block text-xs leading-5 text-muted-foreground">Stored inside the selected Studio data root with private permissions.</span></span>
            </label>
            <label class="focus-within:ring-2 focus-within:ring-ring flex cursor-pointer items-start gap-3 rounded border border-border p-3 {settings.apiKey.backendAvailability.os === 'unavailable' ? 'cursor-not-allowed opacity-60' : ''}">
              <input class="mt-0.5 size-4" type="radio" name="credential-backend" value="os" bind:group={credentialChoice} disabled={settings.apiKey.backendAvailability.os === 'unavailable'} />
              <span><strong class="text-sm">Operating-system store</strong><span class="mt-1 block text-xs leading-5 text-muted-foreground">macOS Keychain when supported. Availability is checked only after this explicit choice.</span></span>
            </label>
          </div>
        </fieldset>
        <form onsubmit={saveApiKey} class="mt-5">
          <label for="onboard-key" class="text-xs font-semibold">Poyo API key</label>
          <p class="mt-1 text-xs leading-5 text-muted-foreground">
            {settings.apiKey.status === 'configured' && credentialChoice !== settings.apiKey.selectedBackend
              ? 'Leave blank to move the currently configured key.'
              : 'The value is submitted once and never returned to this page.'}
          </p>
          <div class="mt-1.5 flex flex-col gap-2 sm:flex-row">
            <input
              id="onboard-key"
              type="password"
              bind:value={apiKeyInput}
              autocomplete="off"
              spellcheck="false"
              placeholder="Stored securely; never shown again"
              class="focus-ring h-10 min-w-0 flex-1 rounded border border-input bg-background px-3 text-sm"
            />
            <Button
              variant="primary"
              type="submit"
              disabled={busy ||
                (!apiKeyInput.trim() && credentialChoice === settings.apiKey.selectedBackend)}
            >
              {credentialChoice === settings.apiKey.selectedBackend ? 'Store key' : 'Move key securely'}
            </Button>
          </div>
          {#if credentialChoice !== settings.apiKey.selectedBackend}
            <label class="mt-3 flex items-start gap-2 text-xs leading-5">
              <input class="focus-ring mt-0.5 size-4" type="checkbox" bind:checked={replaceExistingCredential} />
              Allow replacement only if a different key already exists in the selected destination.
            </label>
          {/if}
        </form>
      {/if}
      {#if keyState.canTest || settings.apiKey.status === 'configured'}
        <Button variant="outline" class="mt-4" onclick={testConnectivity} disabled={busy}>
          <AppIcon name="wifi" size={15} /> Test connection
        </Button>
      {/if}
    {:else if step === 'theme'}
      <p class="mt-3 text-sm leading-6 text-muted-foreground">
        Pick how the studio looks. This applies immediately and is saved as your default.
      </p>
      <div
        class="mt-4 grid grid-cols-3 gap-1 rounded-[var(--radius)] bg-muted p-1"
        role="radiogroup"
        aria-label="Appearance"
      >
        {#each themePreferences as preference (preference)}
          <label
            class="focus-within:ring-2 focus-within:ring-ring flex min-h-9 cursor-pointer items-center justify-center rounded px-2 text-sm font-semibold {themeChoice ===
            preference
              ? 'bg-background shadow-[var(--shadow-xs)]'
              : 'text-muted-foreground'}"
          >
            <input
              class="sr-only"
              type="radio"
              name="theme-preference"
              value={preference}
              checked={themeChoice === preference}
              onchange={() => applyTheme(preference)}
            />
            {themeLabels[preference]}
          </label>
        {/each}
      </div>
    {:else if step === 'done'}
      <p class="mt-3 text-sm leading-6 text-muted-foreground">
        Setup is complete. You can revisit any of these choices from Settings at any time.
      </p>
      <dl class="mt-4 grid gap-3 text-sm sm:grid-cols-3">
        <div><dt class="text-muted-foreground">Studio data</dt><dd class="mt-1 font-semibold">{storageRoot.effective.label}</dd></div>
        <div><dt class="text-muted-foreground">API key</dt><dd class="mt-1 font-semibold">{settings.apiKey.status === 'configured' ? 'Connected' : 'Not set'}</dd></div>
        <div><dt class="text-muted-foreground">Appearance</dt><dd class="mt-1 font-semibold capitalize">{settings.theme.defaultMode}</dd></div>
      </dl>
    {/if}
  </div>

  <nav class="mt-5 flex flex-wrap items-center justify-between gap-3" aria-label="Setup navigation">
    <div>
      {#if step !== 'intro'}
        <Button variant="ghost" onclick={back} disabled={busy}>Back</Button>
      {/if}
    </div>
    <div class="flex flex-wrap items-center gap-2">
      {#if step === 'intro'}
        <Button variant="primary" onclick={next}>Get started</Button>
      {:else if step === 'location'}
        <Button
          variant="primary"
          onclick={applyStorageRoot}
          disabled={busy || storageRoot.restartRequired || (!storageRoot.environmentManaged && !storageRoot.mutationAvailable)}
        >
          {storageRoot.environmentManaged || rootChoice === storageRoot.current.kind
            ? 'Continue'
            : 'Move data and require restart'}
        </Button>
      {:else if step === 'apiKey'}
        <Button variant="ghost" onclick={completeApiKeyStep} disabled={busy}>Skip for now</Button>
        <Button variant="primary" onclick={completeApiKeyStep} disabled={busy}>Continue</Button>
      {:else if step === 'theme'}
        <Button variant="primary" onclick={saveTheme} disabled={busy}>Save and continue</Button>
      {:else if step === 'done'}
        <Button variant="primary" onclick={finish} disabled={busy}>Enter the studio</Button>
      {/if}
    </div>
  </nav>
</div>
