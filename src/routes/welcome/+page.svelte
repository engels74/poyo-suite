<script lang="ts">
import { untrack } from 'svelte';
import { goto } from '$app/navigation';
import AppIcon from '$lib/components/ui/AppIcon.svelte';
import Badge from '$lib/components/ui/Badge.svelte';
import Button from '$lib/components/ui/Button.svelte';
import type {
  OnboardingStateDto,
  OutputLocationDto,
  SettingsDto
} from '$lib/features/settings/contracts';
import { apiKeyUiState, operationsRequest, settingsDraft } from '$lib/features/settings/controller';
import { resolveTheme, themePreferences, themeStorageKey, type ThemePreference } from '$lib/theme';
import type { PageData } from './$types';

interface DirectoryCheck {
  ok: boolean;
  code: string;
  message: string;
  path: string;
  freeBytes: number | null;
}

let { data }: { data: PageData } = $props();
const initial = untrack(() => data);

const steps = ['intro', 'location', 'apiKey', 'theme', 'done'] as const;
type Step = (typeof steps)[number];

let settings = $state<SettingsDto>(initial.settings);
let outputLocation = $state<OutputLocationDto>(initial.outputLocation);
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

let directoryInput = $state('');
let directoryCheck = $state<DirectoryCheck | null>(null);
// Invalidate a prior directory check when the input changes so Save can't act on a stale "ok".
$effect(() => {
  directoryInput;
  directoryCheck = null;
});

let apiKeyInput = $state('');
let connectivityLabel = $state('');

let themeChoice = $state<ThemePreference>(untrack(() => initial.settings.theme.defaultMode));

let heading = $state<HTMLHeadingElement | null>(null);
let keyState = $derived(apiKeyUiState(settings.apiKey));
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
    error?: { message?: string };
    result?: { message?: string };
  };
  if (!response.ok)
    throw new Error(
      payload.error?.message ?? payload.result?.message ?? `Request failed (${response.status}).`
    );
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

function checkDirectory(): void {
  if (!directoryInput.trim()) return;
  void run(async () => {
    // The check endpoint returns a structured `result` for both success and expected validation
    // failures (422), so read it directly rather than via request(), whose throw-on-non-2xx would
    // drop the per-field feedback and leave only the page-level error banner.
    const response = await fetch('/api/settings/output-location', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directory: directoryInput })
    });
    const payload = (await response.json().catch(() => ({}))) as {
      result?: DirectoryCheck;
      error?: { message?: string };
    };
    if (!payload.result)
      throw new Error(payload.error?.message ?? `Request failed (${response.status}).`);
    directoryCheck = payload.result;
  });
}

function saveDirectory(): void {
  void run(async () => {
    const result = await request<{ result: DirectoryCheck; outputLocation: OutputLocationDto }>(
      '/api/settings/output-location',
      'PUT',
      { directory: directoryInput }
    );
    outputLocation = result.outputLocation;
    directoryCheck = result.result;
    await markStep({ location: true });
    next();
    // Set the confirmation after advancing: goToStep() clears `message`, so setting it earlier
    // would wipe the success feedback before it renders.
    message = outputLocation.requiresRestart
      ? 'Saved. New generations use this folder after the next restart; existing media stays available.'
      : 'Output folder saved.';
  });
}

function keepDefaultLocation(): void {
  void run(async () => {
    await markStep({ location: true });
    next();
  });
}

function saveApiKey(event: SubmitEvent): void {
  event.preventDefault();
  if (!keyState.canConfigure || !apiKeyInput.trim()) return;
  void run(async () => {
    try {
      const result = await request<{ apiKey: SettingsDto['apiKey'] }>(
        '/api/settings/api-key',
        'PUT',
        { apiKey: apiKeyInput }
      );
      settings = { ...settings, apiKey: result.apiKey };
      message = 'Key stored by the local server only. Its value never returns to this page.';
    } finally {
      apiKeyInput = '';
    }
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
  location: 'Where should generated media live?',
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
        We will set the output location, your API key, and appearance. Every step is optional and you
        can change all of this later in Settings.
      </p>
      <ul class="mt-4 grid gap-2 text-sm">
        <li class="flex items-center gap-2"><AppIcon name="shield" size={16} class="text-muted-foreground" /> Keys stay on the loopback server, never in the browser.</li>
        <li class="flex items-center gap-2"><AppIcon name="sparkles" size={16} class="text-muted-foreground" /> Existing media and jobs are preserved.</li>
      </ul>
    {:else if step === 'location'}
      <p class="mt-3 text-sm leading-6 text-muted-foreground">
        Generated media is written here now:
      </p>
      <p class="mt-2 break-all rounded bg-muted px-3 py-2 font-mono text-xs">{outputLocation.active}</p>
      {#if outputLocation.environmentManaged}
        <p class="mt-4 rounded border border-border bg-muted/60 px-4 py-3 text-sm text-muted-foreground">
          The output location is controlled by the <span class="font-mono">PLS_MEDIA_DIR</span> environment
          variable and cannot be changed here.
        </p>
      {:else}
        <label class="mt-5 block text-xs font-semibold" for="output-dir">Choose a different folder (optional)</label>
        <div class="mt-1.5 flex flex-col gap-2 sm:flex-row">
          <input
            id="output-dir"
            bind:value={directoryInput}
            spellcheck="false"
            autocomplete="off"
            placeholder="/absolute/path/to/folder"
            class="focus-ring h-10 min-w-0 flex-1 rounded border border-input bg-background px-3 font-mono text-sm"
          />
          <Button variant="outline" onclick={checkDirectory} disabled={busy || !directoryInput.trim()}>
            Check folder
          </Button>
        </div>
        {#if directoryCheck}
          <p
            class="mt-2 text-xs {directoryCheck.ok ? 'text-success' : 'text-destructive'}"
            role="status"
          >
            {directoryCheck.message}{directoryCheck.freeBytes !== null && directoryCheck.ok
              ? ` · ${(directoryCheck.freeBytes / 1024 ** 3).toFixed(1)} GB free`
              : ''}
          </p>
        {/if}
      {/if}
    {:else if step === 'apiKey'}
      <div class="mt-3 flex flex-wrap items-center gap-2">
        <Badge tone={settings.apiKey.status === 'configured' ? 'success' : 'warning'}>{keyState.label}</Badge>
        {#if connectivityLabel}<span class="text-xs text-muted-foreground">{connectivityLabel}</span>{/if}
      </div>
      <p class="mt-3 text-sm leading-6 text-muted-foreground">{keyState.detail}</p>
      {#if keyState.canConfigure}
        <form onsubmit={saveApiKey} class="mt-5">
          <label for="onboard-key" class="text-xs font-semibold">Poyo API key</label>
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
            <Button variant="primary" type="submit" disabled={busy || !apiKeyInput.trim()}>Store key</Button>
          </div>
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
        <div><dt class="text-muted-foreground">Output</dt><dd class="mt-1 font-semibold">{outputLocation.environmentManaged ? 'Environment managed' : outputLocation.configured ? 'Custom folder' : 'Default'}</dd></div>
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
        <Button variant="ghost" onclick={keepDefaultLocation} disabled={busy}>Use default</Button>
        {#if !outputLocation.environmentManaged}
          <Button variant="primary" onclick={saveDirectory} disabled={busy || !directoryCheck?.ok}>
            Save folder
          </Button>
        {:else}
          <Button variant="primary" onclick={keepDefaultLocation} disabled={busy}>Continue</Button>
        {/if}
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
