<script lang="ts">
import { untrack } from 'svelte';
import { goto, invalidateAll } from '$app/navigation';
import SettingsNavigation from '$lib/components/settings/SettingsNavigation.svelte';
import MediaPrivacyControls from '$lib/components/settings/MediaPrivacyControls.svelte';
import ThemeToggle from '$lib/components/shell/ThemeToggle.svelte';
import AppIcon from '$lib/components/ui/AppIcon.svelte';
import Badge from '$lib/components/ui/Badge.svelte';
import type { CleanupConsequence, CleanupPreviewDto } from '$lib/features/cleanup/contracts';
import { byteSizeLabel, dateTimeLabel } from '$lib/features/library/presentation';
import type { SettingsDto } from '$lib/features/settings/contracts';
import {
  parsePublicIpv4,
  type PublicIpv4GuardSettings,
  type PublicIpv4StatusDto
} from '$lib/features/settings/public-ipv4-guard';
import {
  apiKeyUiState,
  cleanupConsequenceLabel,
  cleanupPolicyRequest,
  mediaPrivacyRequest,
  operationsRequest,
  settingsDraft
} from '$lib/features/settings/controller';
import { resolveTheme, themeStorageKey } from '$lib/theme';
import type { PageData } from './$types';

type PublicIpv4GuardResponse = {
  settings: PublicIpv4GuardSettings;
  status: PublicIpv4StatusDto;
};

let { data }: { data: PageData } = $props();
const initial = untrack(() => data);
let settings = $state<SettingsDto>(initial.settings);
let draft = $state(settingsDraft(initial.settings));
let connectivity = $state(initial.connectivity);
let account = $state(initial.balance?.email ?? null);
let apiKeyInput = $state('');
let pending = $state<string | null>(null);
let message = $state('');
let errorMessage = $state('');
let consequence = $state<CleanupConsequence>(initial.settings.localCleanup.consequence);
let preview = $state<CleanupPreviewDto | null>(null);
let cleanupConfirmed = $state(false);
let publicIpv4Guard = $state<PublicIpv4GuardSettings>(initial.publicIpv4Guard);
let publicIpv4Status = $state<PublicIpv4StatusDto>(initial.publicIpv4Status);
let homeIpv4Draft = $state(initial.publicIpv4Guard.homeIpv4 ?? '');

let homeIpv4DraftState = $derived.by(() => {
  if (!homeIpv4Draft.trim()) return { canonical: null, validation: '' };
  try {
    return { canonical: parsePublicIpv4(homeIpv4Draft), validation: '' };
  } catch (error) {
    return {
      canonical: null,
      validation: error instanceof Error ? error.message : 'Enter a valid public IPv4 address.'
    };
  }
});
let homeIpv4CanonicalDraft = $derived(homeIpv4DraftState.canonical);
let homeIpv4Validation = $derived(homeIpv4DraftState.validation);
let homeIpv4Dirty = $derived(
  homeIpv4CanonicalDraft !== publicIpv4Guard.homeIpv4 ||
    (homeIpv4CanonicalDraft === null && Boolean(homeIpv4Draft.trim()))
);
let homeIpv4CanSave = $derived(
  homeIpv4Dirty &&
    !homeIpv4Validation &&
    (!publicIpv4Guard.enabled || homeIpv4CanonicalDraft !== null)
);
let publicIpv4GuardCanEnable = $derived(publicIpv4Guard.homeIpv4 !== null && !homeIpv4Dirty);
let publicIpv4GuardBadge = $derived.by(() => {
  if (!publicIpv4Guard.enabled) return { tone: 'neutral', label: 'Off by default' } as const;
  if (publicIpv4Status.state === 'misconfigured') {
    return { tone: 'warning', label: 'Needs configuration' } as const;
  }
  if (publicIpv4Status.state === 'unavailable') {
    return { tone: 'warning', label: 'Check unavailable' } as const;
  }
  if (publicIpv4Status.state === 'blocked') {
    return { tone: 'danger', label: 'Blocking Poyo' } as const;
  }
  return { tone: 'success', label: 'Enabled' } as const;
});

let keyState = $derived(apiKeyUiState(settings.apiKey));

$effect(() => {
  publicIpv4Status = data.publicIpv4Status;
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
      operations: operationsRequest(draft),
      mediaPrivacy: mediaPrivacyRequest(draft)
    });
    adopt(result.settings);
    applyBrowserTheme();
    message = 'Settings saved.';
  });
}

function clearLogs(): void {
  if (!confirm('Clear all local structured log files? This cannot be undone.')) return;
  void run('clear-logs', async () => {
    await request<{ cleared: true }>('/api/settings/logs', 'DELETE', { confirmed: true });
    message = 'Cleared all local structured logs.';
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
      connectivity = { status: null, checkedAt: null };
      account = null;
      message =
        'The key was stored only by the local server. Its value is no longer available to this page.';
    } finally {
      apiKeyInput = '';
    }
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

function saveHomeIpv4(): void {
  if (!homeIpv4CanSave) return;
  void run('public-ip-home', async () => {
    const result = await request<PublicIpv4GuardResponse>(
      '/api/settings/public-ipv4-guard',
      'PUT',
      {
        enabled: publicIpv4Guard.enabled,
        homeIpv4: homeIpv4CanonicalDraft
      }
    );
    publicIpv4Guard = result.settings;
    publicIpv4Status = result.status;
    homeIpv4Draft = result.settings.homeIpv4 ?? '';
    message = result.settings.homeIpv4 ? 'Home public IPv4 saved.' : 'Home public IPv4 cleared.';
    await invalidateAll();
  });
}

function setPublicIpv4GuardEnabled(event: Event): void {
  const input = event.currentTarget as HTMLInputElement;
  const enabled = input.checked;
  if (enabled && !publicIpv4GuardCanEnable) {
    input.checked = false;
    return;
  }
  const previous = publicIpv4Guard;
  publicIpv4Guard = { ...publicIpv4Guard, enabled };
  void run('public-ip-toggle', async () => {
    try {
      const result = await request<PublicIpv4GuardResponse>(
        '/api/settings/public-ipv4-guard',
        'PUT',
        {
          enabled,
          homeIpv4: previous.homeIpv4
        }
      );
      publicIpv4Guard = result.settings;
      publicIpv4Status = result.status;
      message = enabled ? 'Exact public IPv4 guard enabled.' : 'Public IPv4 guard disabled.';
      await invalidateAll();
    } catch (error) {
      publicIpv4Guard = previous;
      throw error;
    }
  });
}

function useCurrentPublicIpv4(): void {
  if (publicIpv4Status.currentIpv4) homeIpv4Draft = publicIpv4Status.currentIpv4;
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
          <dl class="mt-4 grid gap-3 text-xs sm:grid-cols-2"><div><dt class="text-muted-foreground">Credential source</dt><dd class="mt-1 font-semibold">{settings.apiKey.environmentManaged ? 'Server environment' : settings.apiKey.source === 'local' ? 'Local secret store' : 'Not configured'}</dd></div><div><dt class="text-muted-foreground">Last key change</dt><dd class="mt-1 font-semibold">{settings.apiKey.updatedAt ? dateTimeLabel(settings.apiKey.updatedAt) : 'Never'}</dd></div></dl>
          {#if settings.apiKey.environmentManaged}
            <p class="mt-5 rounded border border-border bg-muted/50 px-3 py-2 text-xs leading-5 text-muted-foreground">The server environment supplies the active credential. Browser changes and local deletion are disabled while it remains active.</p>
          {/if}
          {#if keyState.canConfigure}
            <form onsubmit={configureApiKey} class="mt-5 max-w-xl">
              <label for="local-api-key" class="text-xs font-semibold">{settings.apiKey.source === 'local' ? 'Replace local key' : 'Add a local server-side key'}</label>
              <p class="mt-1 text-xs leading-5 text-muted-foreground">This field is cleared immediately after submission. The value is never stored in browser storage, returned to the page, or written to structured logs.</p>
              <div class="mt-2 flex flex-col gap-2 sm:flex-row"><input id="local-api-key" type="password" bind:value={apiKeyInput} autocomplete="off" spellcheck="false" class="focus-ring h-10 min-w-0 flex-1 rounded border border-input bg-background px-3 text-sm" placeholder="Temporary entry — never displayed again" /><button type="submit" disabled={pending !== null || !apiKeyInput.trim()} class="focus-ring min-h-10 rounded bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50">Store locally</button></div>
            </form>
          {/if}
          <div class="mt-5 flex flex-wrap items-center gap-2"><button onclick={testConnectivity} disabled={pending !== null || !keyState.canTest} class="focus-ring inline-flex min-h-9 items-center gap-2 rounded border border-border px-3 text-sm font-semibold disabled:opacity-50"><AppIcon name="wifi" size={15} /> Test connection</button>{#if keyState.canRemove}<button onclick={removeApiKey} disabled={pending !== null} class="focus-ring min-h-9 rounded border border-destructive/40 px-3 text-sm font-semibold text-destructive">Remove local key</button>{/if}<span class="text-xs text-muted-foreground">{connectivity.checkedAt ? `${connectivity.status === 'ok' ? 'Passed' : 'Failed'} ${dateTimeLabel(connectivity.checkedAt)}` : 'Not checked'}{account ? ` · ${account}` : ''}</span></div>
        </section>

        <section id="public-ip-guard" class="scroll-mt-24 py-6" aria-labelledby="public-ip-guard-heading">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div class="max-w-2xl">
              <div class="flex flex-wrap items-center gap-2">
                <h3 id="public-ip-guard-heading" class="section-heading">Exact public IPv4 guardrail</h3>
                <Badge tone={publicIpv4GuardBadge.tone}>
                  {publicIpv4GuardBadge.label}
                </Badge>
              </div>
              <p class="mt-2 text-sm leading-6 text-muted-foreground">
                This is an exact known-IP comparison, not a VPN detector. When enabled, the server checks its own outbound public IPv4 immediately before each Poyo request and blocks if it matches the saved home address.
              </p>
              {#if publicIpv4Status.state === 'misconfigured'}
                <p class="mt-3 rounded border border-warning/40 bg-warning/10 px-3 py-2 text-xs leading-5" role="alert">
                  The saved guard settings are invalid, so all Poyo requests are blocked. Disable the guard or save a valid home public IPv4.
                </p>
              {/if}
            </div>
            <div class="text-right text-xs">
              <p class="text-muted-foreground">Current server outbound IPv4</p>
              <p class="mt-1 font-mono font-semibold">{publicIpv4Status.currentIpv4 ?? 'Unavailable'}</p>
            </div>
          </div>

          <div class="mt-5 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <label class="text-xs font-semibold" for="home-public-ipv4">
              Normal/home public IPv4
              <input
                id="home-public-ipv4"
                bind:value={homeIpv4Draft}
                inputmode="decimal"
                autocomplete="off"
                spellcheck="false"
                aria-describedby="home-public-ipv4-help"
                aria-invalid={Boolean(homeIpv4Validation)}
                class="focus-ring mt-1.5 h-10 w-full rounded border border-input bg-background px-3 font-mono text-sm"
                placeholder="8.8.4.4"
              />
            </label>
            <div class="flex flex-wrap gap-2">
              <button
                type="button"
                onclick={useCurrentPublicIpv4}
                disabled={!publicIpv4Status.currentIpv4 || pending !== null}
                class="focus-ring min-h-10 rounded border border-border px-3 text-sm font-semibold disabled:opacity-50"
              >Use current IP</button>
              <button
                type="button"
                onclick={saveHomeIpv4}
                disabled={!homeIpv4CanSave || pending !== null}
                class="focus-ring min-h-10 rounded bg-primary px-3 text-sm font-semibold text-primary-foreground disabled:opacity-50"
              >{pending === 'public-ip-home' ? 'Saving…' : 'Save address'}</button>
            </div>
          </div>
          <p id="home-public-ipv4-help" class={`mt-2 text-xs leading-5 ${homeIpv4Validation ? 'text-warning' : 'text-muted-foreground'}`}>
            {homeIpv4Validation || (homeIpv4Dirty ? homeIpv4CanonicalDraft ? 'Unsaved changes. Save this address before enabling the guard.' : publicIpv4Guard.enabled ? 'Disable the guard before clearing the saved home public IPv4.' : 'Unsaved change. Save to clear the stored home public IPv4.' : homeIpv4Draft.trim() ? 'Saved in canonical dotted-decimal form. “Use current IP” changes only this draft until you save.' : 'No home public IPv4 is saved. Enter one before enabling the guard.')}
          </p>

          <label class="mt-5 flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={publicIpv4Guard.enabled}
              disabled={pending !== null || (!publicIpv4Guard.enabled && !publicIpv4GuardCanEnable)}
              onchange={setPublicIpv4GuardEnabled}
              class="focus-ring mt-0.5 size-4"
            />
            <span>
              <strong>Block Poyo requests on the saved home IPv4</strong>
              <span class="mt-1 block text-xs leading-5 text-muted-foreground">
                If the address check is unavailable while enabled, the server fails closed before contacting Poyo. Save a valid address before enabling.
              </span>
            </span>
          </label>

          <p class="mt-5 border-t border-border pt-4 text-xs leading-5 text-muted-foreground">
            Exact IPv4 comparison cannot protect against a changed or dynamic home IP, IPv6 traffic, lookup-provider failure, split tunnelling, or a network change in the brief interval after a check.
          </p>
        </section>

        <section id="storage" class="py-6" aria-labelledby="storage-heading">
          <div class="flex flex-wrap items-start justify-between gap-4"><div><h3 id="storage-heading" class="section-heading">Storage and downloads</h3><p class="mt-2 text-sm leading-6 text-muted-foreground">Jobs, media, settings, logs, and recovery records remain in server-managed local storage. The browser receives safe identifiers and verified media responses, never local filesystem paths.</p></div><Badge tone="neutral">{settings.storage.source === 'environment' ? 'Server configured' : 'Local default'}</Badge></div>
          <dl class="mt-4 grid gap-3 text-xs sm:grid-cols-2"><div><dt class="text-muted-foreground">Indexed media</dt><dd class="mt-1 font-semibold">{byteSizeLabel(data.storage.indexedBytes)} · {data.storage.verifiedFiles} verified files</dd></div><div><dt class="text-muted-foreground">Disk free</dt><dd class="mt-1 font-semibold">{data.storage.freeBytes === null ? 'Unavailable' : byteSizeLabel(data.storage.freeBytes)}</dd></div></dl>
          <div class="mt-5 border-t border-border pt-4">
            <h4 class="text-xs font-semibold">Local-only data boundary</h4>
            <p class="mt-2 text-xs leading-5 text-muted-foreground">Storage stays behind the loopback backend. The application does not scan other locations, open a file manager, or send local media and diagnostics anywhere except when a Poyo request explicitly requires uploaded input.</p>
          </div>
          <label class="mt-5 flex items-start gap-3 text-sm"><input type="checkbox" bind:checked={draft.automaticDownloads} class="focus-ring mt-0.5 size-4" /><span><strong>Download successful outputs automatically</strong><span class="mt-1 block text-xs leading-5 text-muted-foreground">Recommended because remote retention is not documented.</span></span></label>
        </section>

        <section id="media-privacy" class="py-6" aria-label="Media privacy settings">
          <MediaPrivacyControls bind:mediaPrivacy={draft.mediaPrivacy} disabled={pending !== null} />
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

        <section id="logging" class="py-6" aria-labelledby="logging-heading"><h3 id="logging-heading" class="section-heading">Structured log rotation</h3><p class="mt-2 text-sm leading-6 text-muted-foreground">Logs are local JSONL, redact secret-like values, and use bounded size, age, and retained-file limits.</p><div class="mt-4 grid gap-4 sm:grid-cols-2"><label class="text-xs font-semibold">Rotate at size (MB)<input type="number" min="0.0625" max="1024" step="0.25" bind:value={draft.logSizeMb} class="focus-ring mt-1.5 h-10 w-full rounded border border-input bg-background px-3 text-sm" /></label><label class="text-xs font-semibold">Rotate at age (hours)<input type="number" min="0.0167" max="720" step="1" bind:value={draft.logAgeHours} class="focus-ring mt-1.5 h-10 w-full rounded border border-input bg-background px-3 text-sm" /></label><label class="text-xs font-semibold">Retention (days)<input type="number" min="0.0417" max="365" step="1" bind:value={draft.logRetentionDays} class="focus-ring mt-1.5 h-10 w-full rounded border border-input bg-background px-3 text-sm" /></label><label class="text-xs font-semibold">Maximum rotated files<input type="number" min="1" max="100" bind:value={draft.maxRotatedFiles} class="focus-ring mt-1.5 h-10 w-full rounded border border-input bg-background px-3 text-sm" /></label></div><label class="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" bind:checked={draft.separateErrorFile} class="focus-ring size-4" /> Keep a separate error stream</label><div class="mt-5 border-t border-border pt-4"><p class="text-xs leading-5 text-muted-foreground">Clear every managed log file after queued writes finish. This does not affect jobs, media, settings, or diagnostics.</p><button onclick={clearLogs} disabled={pending !== null} class="focus-ring mt-3 min-h-9 rounded border border-destructive/40 px-3 text-sm font-semibold text-destructive disabled:opacity-50">{pending === 'clear-logs' ? 'Clearing logs…' : 'Clear local logs'}</button></div></section>

        <section id="appearance" class="py-6" aria-labelledby="appearance-heading"><h3 id="appearance-heading" class="section-heading">Appearance</h3><p class="mt-2 text-sm leading-6 text-muted-foreground">Light remains the product default. Save a local installation preference and use the adjacent control to cycle this browser immediately.</p><div class="mt-4 flex flex-wrap items-center gap-2"><label class="text-xs font-semibold">Default mode<select bind:value={draft.theme} class="focus-ring ml-2 h-9 rounded border border-input bg-background px-3 text-sm"><option value="light">Light</option><option value="dark">Dark</option><option value="system">System</option></select></label><ThemeToggle class="border border-border bg-background" /></div></section>

        <section id="registry" class="py-6" aria-labelledby="registry-heading"><h3 id="registry-heading" class="section-heading">Registry and versions</h3><p class="mt-2 text-sm leading-6 text-muted-foreground">The local audited registry is seeded into SQLite at startup.</p><dl class="mt-4 grid gap-3 text-xs sm:grid-cols-3"><div><dt class="text-muted-foreground">Application</dt><dd class="mt-1 font-mono font-semibold">{data.versions.application}</dd></div><div><dt class="text-muted-foreground">Database schema</dt><dd class="mt-1 font-mono font-semibold">{data.versions.databaseSchema}</dd></div><div><dt class="text-muted-foreground">Registry schema</dt><dd class="mt-1 font-mono font-semibold">{data.versions.registrySchema}</dd></div></dl><ul class="mt-4 divide-y divide-border border-y border-border">{#each data.registry as registry}<li class="grid gap-1 py-3 text-xs sm:grid-cols-[minmax(0,1fr)_auto_auto]"><span class="font-mono font-semibold">{registry.version}</span><span>{registry.status}</span><time class="text-muted-foreground" datetime={registry.verifiedAt}>{dateTimeLabel(registry.verifiedAt)}</time></li>{/each}</ul></section>
      </div>

      <div class="sticky bottom-16 z-10 mt-5 flex flex-wrap items-center justify-between gap-3 rounded border border-border bg-background/95 p-2.5 shadow-[var(--shadow-md)] backdrop-blur sm:p-3 lg:bottom-4"><p class="hidden text-xs text-muted-foreground sm:block">Saves media privacy, polling, download, logging, and default theme settings. Cleanup policy is saved by its preview action.</p><button onclick={saveOperations} disabled={pending !== null} class="focus-ring min-h-10 w-full rounded bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50 sm:w-auto">{pending === 'operations' ? 'Saving…' : 'Save settings'}</button></div>
    </section>
  </div>
</div>
