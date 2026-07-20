<script lang="ts">
import { tick, untrack } from 'svelte';
import { goto } from '$app/navigation';
import MediaPrivacyControls from '$lib/components/settings/MediaPrivacyControls.svelte';
import AppIcon from '$lib/components/ui/AppIcon.svelte';
import Badge from '$lib/components/ui/Badge.svelte';
import Button from '$lib/components/ui/Button.svelte';
import type { OnboardingStateDto, SettingsDto } from '$lib/features/settings/contracts';
import {
  apiKeyUiState,
  mediaPrivacyRequest,
  operationsRequest,
  settingsDraft
} from '$lib/features/settings/controller';
import { mediaSanitizationCapabilityState } from '$lib/features/settings/media-privacy';
import { resolveTheme, type ThemePreference, themePreferences, themeStorageKey } from '$lib/theme';
import type { PageData } from './$types';

let { data }: { data: PageData } = $props();
const initial = untrack(() => data);

const setupSteps = ['location', 'mediaPrivacy', 'apiKey', 'theme', 'defaults'] as const;
const steps = ['intro', ...setupSteps, 'done'] as const;
type SetupStep = (typeof setupSteps)[number];
type Step = (typeof steps)[number];

let settings = $state<SettingsDto>(initial.settings);
function firstIncompleteStep(state: OnboardingStateDto): Step {
  const { location, mediaPrivacy, connection, theme, defaults } = state.steps;
  if (!location && !mediaPrivacy && !connection && !theme && !defaults) return 'intro';
  if (!location) return 'location';
  if (!mediaPrivacy) return 'mediaPrivacy';
  if (!connection) return 'apiKey';
  if (!theme) return 'theme';
  if (!defaults) return 'defaults';
  return 'done';
}

let step = $state<Step>(untrack(() => firstIncompleteStep(initial.onboarding)));
let busy = $state(false);
let message = $state('');
let errorMessage = $state('');
let apiKeyInput = $state('');
type ConnectivityState = 'not-tested' | 'testing' | 'success' | 'failure';
let connectivityState = $state<ConnectivityState>(
  initial.settings.apiKey.status === 'configured' && initial.connectivity.status === 'ok'
    ? 'success'
    : 'not-tested'
);
let connectivityAccount = $state<string | null>(null);
let themeChoice = $state<ThemePreference>(untrack(() => initial.settings.theme.defaultMode));
let mediaPrivacy = $state({ ...initial.settings.mediaPrivacy });
let heading = $state<HTMLHeadingElement | null>(null);
let connectivityButton = $state<HTMLButtonElement | undefined>();

let keyState = $derived(apiKeyUiState(settings.apiKey));
let stepIndex = $derived(steps.indexOf(step));
let setupStepIndex = $derived(
  step === 'done' ? setupSteps.length : setupSteps.indexOf(step as SetupStep)
);
let connectivityLabel = $derived(
  connectivityState === 'testing'
    ? 'Testing connection…'
    : connectivityState === 'success'
      ? `Connected${connectivityAccount ? ` · ${connectivityAccount}` : ''}`
      : connectivityState === 'failure'
        ? 'Connection failed. Check the key and try again.'
        : 'Not tested'
);
let mediaCapabilityState = $derived(mediaSanitizationCapabilityState(data.mediaTools));
let mediaCleanupSummary = $derived(
  !mediaPrivacy.sanitizeLocalMedia
    ? 'Off'
    : mediaCapabilityState === 'available'
      ? 'Images and videos'
      : data.mediaTools.imageReady
        ? 'Images only'
        : data.mediaTools.videoReady
          ? 'Videos only'
          : 'Optional tools unavailable'
);
let mediaPrivacyActionLabel = $derived(
  mediaCapabilityState === 'unavailable'
    ? 'Continue without media cleanup'
    : !mediaPrivacy.sanitizeLocalMedia
      ? 'Continue with cleanup off'
      : 'Save and continue'
);

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
  if (!response.ok) {
    throw new Error(
      payload.error?.message ?? payload.result?.message ?? `Request failed (${response.status}).`
    );
  }
  return payload;
}

async function run(callback: () => Promise<void>, onSettled?: () => void): Promise<void> {
  busy = true;
  message = '';
  errorMessage = '';
  try {
    await callback();
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'The local operation failed.';
  } finally {
    busy = false;
    if (onSettled) {
      await tick();
      onSettled();
    }
  }
}

function goToStep(nextStep: Step): void {
  message = '';
  errorMessage = '';
  step = nextStep;
}

function next(): void {
  const target = steps[Math.min(stepIndex + 1, steps.length - 1)];
  if (target) goToStep(target);
}

function back(): void {
  const target = steps[Math.max(stepIndex - 1, 0)];
  if (target) goToStep(target);
}

function invalidateConnectivity(): void {
  connectivityState = 'not-tested';
  connectivityAccount = null;
}

async function markStep(patch: Partial<OnboardingStateDto['steps']>): Promise<void> {
  await request<{ onboarding: OnboardingStateDto }>('/api/onboarding', 'PUT', {
    steps: patch
  });
}

function confirmLocation(): void {
  void run(async () => {
    await markStep({ location: true });
    next();
  });
}

function saveMediaPrivacy(): void {
  void run(async () => {
    const draft = { ...settingsDraft(settings), mediaPrivacy };
    const result = await request<{ settings: SettingsDto }>('/api/settings', 'PUT', {
      mediaPrivacy: mediaPrivacyRequest(draft)
    });
    settings = result.settings;
    mediaPrivacy = { ...result.settings.mediaPrivacy };
    await markStep({ mediaPrivacy: true });
    next();
  });
}

async function probeConnectivity(): Promise<void> {
  connectivityState = 'testing';
  connectivityAccount = null;
  try {
    const result = await request<{ connectivity: { status: string; account: string | null } }>(
      '/api/settings/api-key/connectivity',
      'POST',
      {}
    );
    connectivityState = result.connectivity.status === 'ok' ? 'success' : 'failure';
    connectivityAccount = result.connectivity.account;
  } catch (error) {
    connectivityState = 'failure';
    throw error;
  }
}

function saveApiKey(event: SubmitEvent): void {
  event.preventDefault();
  if (!settings.apiKey.localMutationAvailable || !apiKeyInput.trim()) return;
  void run(
    async () => {
      try {
        const result = await request<{ apiKey: SettingsDto['apiKey'] }>(
          '/api/settings/api-key',
          'PUT',
          { apiKey: apiKeyInput }
        );
        settings = { ...settings, apiKey: result.apiKey };
        message = 'Key stored by the local server only. Its value never returns through this page.';
        await probeConnectivity();
      } finally {
        apiKeyInput = '';
      }
    },
    () => connectivityButton?.focus()
  );
}

function testConnectivity(): void {
  void run(probeConnectivity);
}

function completeApiKeyStep(): void {
  void run(async () => {
    await markStep({ connection: true });
    next();
  });
}

function applyTheme(choice: ThemePreference): void {
  themeChoice = choice;
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
    // The server-side preference is still saved when the user continues.
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
  });
}

function acceptDefaults(): void {
  void run(async () => {
    await markStep({ defaults: true });
    next();
  });
}

function leaveSetup(dismiss: boolean): void {
  void run(async () => {
    await request('/api/onboarding', 'PUT', {
      ...(dismiss ? { dismiss: true } : { complete: true }),
      steps: { location: true, mediaPrivacy: true, connection: true, theme: true, defaults: true }
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
  location: 'Your work stays local',
  mediaPrivacy: 'Protect local media metadata',
  apiKey: 'Connect your Poyo API key',
  theme: 'Choose your appearance',
  defaults: 'Review the defaults',
  done: 'You are ready to create'
};
const setupStepLabels: Record<SetupStep, string> = {
  location: 'Privacy',
  mediaPrivacy: 'Media',
  apiKey: 'API key',
  theme: 'Theme',
  defaults: 'Defaults'
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
      {#each setupSteps as setupStep, index (setupStep)}
        <li
          class="flex min-h-6 items-center gap-1.5 rounded-full border px-2.5 text-[0.6875rem] font-semibold {index <
          setupStepIndex
            ? 'border-success/40 bg-success/10 text-foreground'
            : index === setupStepIndex
              ? 'border-primary bg-primary/10 text-foreground'
              : 'border-border text-muted-foreground'}"
          aria-current={index === setupStepIndex ? 'step' : undefined}
        >
          <span class="tabular-nums">{index + 1}</span>
          <span>{setupStepLabels[setupStep]}</span>
        </li>
      {/each}
    </ol>
  </header>

  <div
    class="mt-5 flex-1 overflow-hidden rounded-lg border border-border bg-card p-6 shadow-[var(--shadow-xs)]"
  >
    <h1
      bind:this={heading}
      tabindex="-1"
      class="text-xl font-semibold tracking-tight focus:outline-none"
    >
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
        Set up privacy, your Poyo connection, appearance, and sensible working defaults in five
        short steps.
      </p>
      <ul class="mt-4 grid gap-2 text-sm">
        <li class="flex items-center gap-2">
          <AppIcon name="shield" size={16} class="text-muted-foreground" />
          Files and credentials stay behind the local server, never in browser storage.
        </li>
        <li class="flex items-center gap-2">
          <AppIcon name="sparkles" size={16} class="text-muted-foreground" />
          There is no telemetry; network requests occur only for explicit Poyo operations.
        </li>
      </ul>
    {:else if step === 'location'}
      <p class="mt-3 text-sm leading-6 text-muted-foreground">
        Poyo Local Studio keeps its database, generated media, uploads, logs, and local credential
        on the machine running the Studio. The browser receives safe previews and status details,
        but never local filesystem paths.
      </p>
      <div class="mt-4 rounded border border-border bg-muted/60 px-4 py-3 text-sm">
        <p class="font-semibold">Local by design</p>
        <p class="mt-1 text-xs leading-5 text-muted-foreground">
          {settings.storage.source === 'environment'
            ? 'The server administrator manages the local storage location.'
            : 'The Studio uses its private local application storage.'}
        </p>
      </div>
    {:else if step === 'mediaPrivacy'}
      <div class="mt-4">
        <MediaPrivacyControls bind:mediaPrivacy mediaTools={data.mediaTools} disabled={busy} />
      </div>
    {:else if step === 'apiKey'}
      <div class="mt-3 flex flex-wrap items-center gap-2">
        <Badge tone={settings.apiKey.status === 'configured' ? 'success' : 'warning'}>
          {keyState.label}
        </Badge>
        <span class="text-xs text-muted-foreground" role="status" aria-live="polite">
          {connectivityLabel}
        </span>
      </div>
      <p class="mt-3 text-sm leading-6 text-muted-foreground">{keyState.detail}</p>
      {#if settings.apiKey.environmentManaged}
        <p class="mt-4 rounded border border-border bg-muted/60 px-4 py-3 text-sm text-muted-foreground">
          The Poyo API key is managed by the server environment. Browser-based key changes are
          disabled, but you can verify the connection below.
        </p>
      {:else if settings.apiKey.localMutationAvailable}
        <form onsubmit={saveApiKey} class="mt-5">
          <label for="onboard-key" class="text-xs font-semibold">Poyo API key</label>
          <p class="mt-1 text-xs leading-5 text-muted-foreground">
            The local server stores the key in its account-scoped secret store. Its value is
            never returned to the browser.
          </p>
          <div class="mt-1.5 flex flex-col gap-2 sm:flex-row">
            <input
              id="onboard-key"
              type="password"
              value={apiKeyInput}
              oninput={(event) => {
                apiKeyInput = event.currentTarget.value;
                invalidateConnectivity();
              }}
              autocomplete="off"
              spellcheck="false"
              placeholder="Stored securely; never shown again"
              class="focus-ring h-10 min-w-0 flex-1 rounded border border-input bg-background px-3 text-sm"
            />
            <Button variant="primary" type="submit" disabled={busy || !apiKeyInput.trim()}>
              {settings.apiKey.status === 'configured' ? 'Replace key' : 'Store key'}
            </Button>
          </div>
        </form>
      {:else}
        <p class="mt-4 rounded border border-warning/30 bg-warning/10 px-4 py-3 text-sm">
          Local key storage is unavailable. Ask the server administrator to configure the Poyo API
          key in the environment.
        </p>
      {/if}
      {#if keyState.canTest || settings.apiKey.status === 'configured'}
        <Button
          bind:element={connectivityButton}
          variant="outline"
          class="mt-4"
          onclick={testConnectivity}
          disabled={busy || Boolean(apiKeyInput.trim())}
        >
          <AppIcon name="wifi" size={15} />
          {connectivityState === 'not-tested' ? 'Test connection' : 'Test again'}
        </Button>
      {/if}
    {:else if step === 'theme'}
      <p class="mt-3 text-sm leading-6 text-muted-foreground">
        Pick how the Studio looks. The preview applies immediately and is saved when you continue.
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
    {:else if step === 'defaults'}
      <p class="mt-3 text-sm leading-6 text-muted-foreground">
        The Studio starts with conservative local defaults. You can change them later from Settings.
      </p>
      <dl class="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <div class="rounded border border-border p-3">
          <dt class="text-xs text-muted-foreground">Completed media</dt>
          <dd class="mt-1 font-semibold">
            {settings.downloads.automatic ? 'Downloaded automatically' : 'Downloaded on request'}
          </dd>
        </div>
        <div class="rounded border border-border p-3">
          <dt class="text-xs text-muted-foreground">Local cleanup</dt>
          <dd class="mt-1 font-semibold">Review before removing local files</dd>
        </div>
      </dl>
    {:else if step === 'done'}
      <p class="mt-3 text-sm leading-6 text-muted-foreground">
        Your local choices and verified connection are saved. Complete setup to enter the Studio,
        or dismiss this guide and continue with the same choices.
      </p>
      <dl class="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <div><dt class="text-muted-foreground">Storage</dt><dd class="mt-1 font-semibold">Local</dd></div>
        <div><dt class="text-muted-foreground">API key</dt><dd class="mt-1 font-semibold">Connected</dd></div>
        <div><dt class="text-muted-foreground">Media cleanup</dt><dd class="mt-1 font-semibold">{mediaCleanupSummary}</dd></div>
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
        <Button variant="primary" onclick={confirmLocation} disabled={busy}>Continue</Button>
      {:else if step === 'mediaPrivacy'}
        <Button variant="primary" onclick={saveMediaPrivacy} disabled={busy}>
          {mediaPrivacyActionLabel}
        </Button>
      {:else if step === 'apiKey'}
        <Button
          variant="primary"
          onclick={completeApiKeyStep}
          disabled={busy || connectivityState !== 'success' || Boolean(apiKeyInput.trim())}
        >Continue</Button>
      {:else if step === 'theme'}
        <Button variant="primary" onclick={saveTheme} disabled={busy}>Save and continue</Button>
      {:else if step === 'defaults'}
        <Button variant="primary" onclick={acceptDefaults} disabled={busy}>Use these defaults</Button>
      {:else if step === 'done'}
        <Button variant="outline" onclick={() => leaveSetup(true)} disabled={busy}>Dismiss guide</Button>
        <Button variant="primary" onclick={() => leaveSetup(false)} disabled={busy}>Enter the Studio</Button>
      {/if}
    </div>
  </nav>
</div>
