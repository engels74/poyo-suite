<script lang="ts">
import { untrack } from 'svelte';
import { goto, invalidateAll } from '$app/navigation';
import AppIcon from '$lib/components/ui/AppIcon.svelte';
import Badge from '$lib/components/ui/Badge.svelte';
import LinkButton from '$lib/components/ui/LinkButton.svelte';
import type { JobDetailDto, LocalDeleteChoice } from '$lib/features/library/contracts';
import {
  byteSizeLabel,
  attentionDescription,
  dateTimeLabel,
  elapsedLabel,
  mediaFrameAspectRatio
} from '$lib/features/library/presentation';
import MediaPreview from './MediaPreview.svelte';
import StatusBadge from './StatusBadge.svelte';

interface Props {
  job: JobDetailDto;
}

let { job }: Props = $props();
let pending = $state<string | null>(null);
let feedback = $state('');
let tags = $state(untrack(() => job.tags.join(', ')));
let deleteChoices = $state<Record<string, LocalDeleteChoice>>({});
let promptExpanded = $state(false);
let promptCopyStatus = $state('');
let promptCanCollapse = $derived((job.prompt?.length ?? 0) > 220);
const historyPageSize = 20;
let visibleHistoryCount = $state(historyPageSize);
let visibleHistory = $derived(job.history.slice(0, visibleHistoryCount));
const initialComparison = untrack(() => job.outputs.slice(0, 2).map((output) => output.outputId));
let comparisonLeftId = $state(initialComparison[0] ?? '');
let comparisonRightId = $state(initialComparison[1] ?? initialComparison[0] ?? '');
let comparisonLeft = $derived(
  job.outputs.find((output) => output.outputId === comparisonLeftId) ?? job.outputs[0]
);
let comparisonRight = $derived(
  job.outputs.find((output) => output.outputId === comparisonRightId) ?? job.outputs[1]
);
let requestedAspectRatio = $derived(
  typeof job.guidedRequest.aspectRatio === 'string'
    ? job.guidedRequest.aspectRatio
    : typeof job.guidedRequest.size === 'string'
      ? job.guidedRequest.size
      : null
);

async function post(path: string, body: Record<string, unknown> = {}): Promise<Response> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
      message?: string;
    };
    throw new Error(
      payload.error?.message ?? payload.message ?? `Request failed (${response.status}).`
    );
  }
  return response;
}

async function action(name: string, callback: () => Promise<void>): Promise<void> {
  pending = name;
  feedback = '';
  try {
    await callback();
  } catch (error) {
    feedback = error instanceof Error ? error.message : 'The action failed.';
  } finally {
    pending = null;
  }
}

function refresh(): void {
  void action('refresh', async () => {
    await post(`/api/jobs/${job.id}/refresh`);
    feedback = 'The authoritative Poyo status was refreshed.';
    await invalidateAll();
  });
}

function rerun(): void {
  if (
    !confirm('Create and submit a new paid job with these settings? This may spend Poyo credits.')
  )
    return;
  void action('rerun', async () => {
    const storageKey = `poyo-paid-action:rerun:${job.id}`;
    const actionId = sessionStorage.getItem(storageKey) ?? crypto.randomUUID();
    sessionStorage.setItem(storageKey, actionId);
    const response = await post(`/api/jobs/${job.id}/rerun`, {
      acknowledgeNewPaidJob: true,
      actionId
    });
    const result = (await response.json()) as { job: { id: string } };
    sessionStorage.removeItem(storageKey);
    await goto(`/jobs/${result.job.id}`);
  });
}

function retryAmbiguous(): void {
  if (
    !confirm(
      'Poyo may already have accepted the original paid request. Submit a linked new job anyway? This can spend credits twice.'
    )
  )
    return;
  void action('retry-ambiguous', async () => {
    const storageKey = `poyo-paid-action:ambiguous:${job.id}`;
    const actionId = sessionStorage.getItem(storageKey) ?? crypto.randomUUID();
    sessionStorage.setItem(storageKey, actionId);
    const response = await post(`/api/jobs/${job.id}/retry-ambiguous`, {
      acknowledgeDuplicateSpendRisk: true,
      actionId
    });
    const result = (await response.json()) as { job: { id: string } };
    sessionStorage.removeItem(storageKey);
    await goto(`/jobs/${result.job.id}`);
  });
}

function retryDownload(outputId: string): void {
  void action(`retry-${outputId}`, async () => {
    await post(`/api/jobs/${job.id}/outputs/${outputId}/retry`);
    feedback = 'Download retry queued. The generation itself was not resubmitted.';
    await invalidateAll();
  });
}

function toggle(kind: 'favorite' | 'pin', value: boolean): void {
  void action(kind, async () => {
    await post(`/api/library/${job.id}/${kind}`, {
      [kind === 'favorite' ? 'favorite' : 'pinned']: value
    });
    await invalidateAll();
  });
}

function saveTags(): void {
  void action('tags', async () => {
    const response = await post(`/api/library/${job.id}/tags`, { tags: tags.split(',') });
    const result = (await response.json()) as { tags: string[] };
    tags = result.tags.join(', ');
    feedback = 'Tags saved.';
    await invalidateAll();
  });
}

async function copyPrompt(): Promise<void> {
  if (job.prompt === null) return;
  try {
    await navigator.clipboard.writeText(job.prompt);
    promptCopyStatus = 'Prompt copied.';
  } catch {
    promptCopyStatus = 'The browser did not allow clipboard access.';
  }
}

function removeOutput(outputId: string): void {
  const choice = deleteChoices[outputId] ?? 'file';
  const consequence =
    choice === 'file'
      ? 'the local file'
      : choice === 'metadata'
        ? 'the local output record (the file will remain on disk)'
        : 'the local file and its metadata';
  if (!confirm(`Permanently remove ${consequence}? This does not delete anything from Poyo.`))
    return;
  void action(`delete-${outputId}`, async () => {
    await post(`/api/library/${job.id}/outputs/${outputId}/delete`, { choice });
    feedback = 'Local deletion completed. No remote deletion was requested.';
    await invalidateAll();
  });
}
</script>

<div class="route-shell">
  <a href="/jobs" class="focus-ring inline-flex items-center gap-1 rounded text-xs font-semibold text-muted-foreground hover:text-foreground">← Back to jobs</a>
  <header class="mt-4 flex flex-wrap items-start justify-between gap-4 border-b border-border pb-5">
    <div class="min-w-0">
      <p class="eyebrow-label">{job.provider} · {job.workflow}</p>
      <h1 class="mt-1 text-2xl font-semibold tracking-tight">{job.displayName}</h1>
      <div class="mt-3 flex flex-wrap items-center gap-2"><StatusBadge localPhase={job.localPhase} remoteStatus={job.remoteStatus} attentionCode={job.attentionCode} /><Badge>{job.publicModelId}</Badge>{#if job.poyoTaskId}<Badge tone="info">Poyo task linked</Badge>{/if}</div>
    </div>
    <div class="flex flex-wrap gap-2">
      <LinkButton href={`/studio/${job.modality}?fromJob=${job.id}`} variant="outline">Edit in studio</LinkButton>
      {#if job.poyoTaskId}<button onclick={refresh} disabled={pending !== null} class="focus-ring inline-flex min-h-9 items-center gap-2 rounded border border-border px-3 text-sm font-semibold"><AppIcon name="refresh" size={15} /> Refresh status</button>{/if}
      {#if job.attentionCode === 'submission_unknown'}
        <button onclick={retryAmbiguous} disabled={pending !== null} class="focus-ring min-h-9 rounded bg-warning px-3 text-sm font-semibold text-warning-foreground">Acknowledge risk and retry</button>
      {:else if !(job.attentionCode === 'ip_guard_blocked' && job.poyoTaskId)}
        <button onclick={rerun} disabled={pending !== null} class="focus-ring min-h-9 rounded bg-primary px-3 text-sm font-semibold text-primary-foreground">Run again</button>
      {/if}
    </div>
  </header>

  {#if job.attentionCode === 'submission_unknown'}<div class="mt-4 rounded border border-warning/40 bg-warning/10 p-4 text-sm"><strong>Submission outcome is unknown.</strong> Status checks are safe. A new paid retry is available only after you explicitly accept the risk that Poyo may charge for both requests.</div>{/if}
  {#if job.attentionCode === 'ip_guard_blocked'}
    <div class="mt-4 rounded border border-warning/40 bg-warning/10 p-4 text-sm">
      <strong>{job.poyoTaskId ? 'Monitoring paused by IP guard.' : job.ipGuardReason === 'unavailable' ? 'IP check unavailable.' : job.ipGuardReason === 'misconfigured' ? 'IP guard settings invalid.' : 'Blocked by IP guard.'}</strong>
      <p class="mt-1 leading-6">{attentionDescription(job.attentionCode, job.ipGuardReason ?? null, Boolean(job.poyoTaskId))}</p>
      <a href="/settings#public-ip-guard" class="focus-ring mt-2 inline-block rounded font-semibold underline underline-offset-2">Review IP guard settings</a>
    </div>
  {/if}
  {#if feedback}<p class="mt-4 rounded border border-border bg-muted px-4 py-3 text-sm" role="status">{feedback}</p>{/if}

  <div class="mt-6 grid gap-8 xl:grid-cols-[minmax(0,1.45fr)_minmax(18rem,0.55fr)]">
    <main>
      <section aria-labelledby="outputs-heading">
        <div class="flex items-end justify-between gap-3"><div><p class="eyebrow-label">Media</p><h2 id="outputs-heading" class="mt-1 text-base font-semibold">{job.outputs.length} {job.outputs.length === 1 ? 'output' : 'outputs'}</h2></div><span class="text-xs text-muted-foreground">{job.verifiedOutputCount} verified locally</span></div>
        {#if job.outputs.length}
          {#if job.outputs.length > 1}
            <section class="mt-4 rounded-lg border border-border bg-muted/40 p-4" aria-labelledby="comparison-heading">
              <div class="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p class="eyebrow-label">Same generation</p>
                  <h3 id="comparison-heading" class="mt-1 text-sm font-semibold">Compare related outputs</h3>
                </div>
                <div class="grid grid-cols-2 gap-2">
                  <label class="grid gap-1 text-xs font-semibold">
                    Output A
                    <select bind:value={comparisonLeftId} class="focus-ring h-8 rounded border border-input bg-background px-2 text-xs">
                      {#each job.outputs as output (output.outputId)}<option value={output.outputId}>Output {output.outputOrder + 1}</option>{/each}
                    </select>
                  </label>
                  <label class="grid gap-1 text-xs font-semibold">
                    Output B
                    <select bind:value={comparisonRightId} class="focus-ring h-8 rounded border border-input bg-background px-2 text-xs">
                      {#each job.outputs as output (output.outputId)}<option value={output.outputId}>Output {output.outputOrder + 1}</option>{/each}
                    </select>
                  </label>
                </div>
              </div>
              <div class="mt-4 grid gap-3 sm:grid-cols-2">
                {#if comparisonLeft}
                  <div>
                    <p class="mb-2 text-xs font-semibold">A · Output {comparisonLeft.outputOrder + 1}</p>
                    <div class="overflow-hidden rounded" style={`aspect-ratio: ${mediaFrameAspectRatio(comparisonLeft.pixelWidth, comparisonLeft.pixelHeight, comparisonLeft.aspectRatio ?? requestedAspectRatio)};`}>
                      <MediaPreview mediaKind={comparisonLeft.mediaKind} src={comparisonLeft.mediaUrl} alt={`${job.displayName} comparison output A`} fit="contain" class="size-full" controls={comparisonLeft.mediaKind === 'video'} viewable />
                    </div>
                  </div>
                {/if}
                {#if comparisonRight}
                  <div>
                    <p class="mb-2 text-xs font-semibold">B · Output {comparisonRight.outputOrder + 1}</p>
                    <div class="overflow-hidden rounded" style={`aspect-ratio: ${mediaFrameAspectRatio(comparisonRight.pixelWidth, comparisonRight.pixelHeight, comparisonRight.aspectRatio ?? requestedAspectRatio)};`}>
                      <MediaPreview mediaKind={comparisonRight.mediaKind} src={comparisonRight.mediaUrl} alt={`${job.displayName} comparison output B`} fit="contain" class="size-full" controls={comparisonRight.mediaKind === 'video'} viewable />
                    </div>
                  </div>
                {/if}
              </div>
            </section>
          {/if}
          <div class="mt-4 grid gap-5 sm:grid-cols-2">
            {#each job.outputs as output (output.outputId)}
              <article class="overflow-hidden rounded-lg border border-border bg-card">
                <div style={`aspect-ratio: ${mediaFrameAspectRatio(output.pixelWidth, output.pixelHeight, output.aspectRatio ?? requestedAspectRatio)};`}>
                  <MediaPreview mediaKind={output.mediaKind} src={output.mediaUrl} alt={`${job.displayName} output ${output.outputOrder + 1}`} fit="contain" class="size-full" controls={output.mediaKind === 'video'} viewable />
                </div>
                <div class="p-4">
                  <div class="flex flex-wrap items-center justify-between gap-2"><p class="text-sm font-semibold">Output {output.outputOrder + 1}</p><Badge tone={output.localAvailable ? 'success' : output.downloadState === 'failed' ? 'danger' : 'warning'}>{output.downloadState}</Badge></div>
                  <dl class="mt-3 grid grid-cols-2 gap-3 text-xs"><div><dt class="text-muted-foreground">File</dt><dd class="mt-1 truncate font-medium">{output.fileName ?? 'No local file'}</dd></div><div><dt class="text-muted-foreground">Size</dt><dd class="mt-1 font-medium">{output.byteSize === null ? '—' : byteSizeLabel(output.byteSize)}</dd></div><div><dt class="text-muted-foreground">Dimensions</dt><dd class="mt-1 font-medium">{output.pixelWidth && output.pixelHeight ? `${output.pixelWidth} × ${output.pixelHeight}` : '—'}</dd></div><div><dt class="text-muted-foreground">Remote</dt><dd class="mt-1 font-medium">{output.remoteHost ?? 'Unavailable'}</dd></div><div><dt class="text-muted-foreground">Checksum</dt><dd class="mt-1 truncate font-mono">{output.checksum?.slice(0, 12) ?? '—'}</dd></div></dl>
                  <div class="mt-4 flex flex-wrap gap-2">
                    {#if output.localAvailable}
                      <a href={output.mediaUrl ?? '#'} target="_blank" rel="noreferrer" class="focus-ring rounded border border-border px-2.5 py-1.5 text-xs font-semibold">Open in browser</a>
                      <a href={`/api/media/${output.outputId}/download`} download data-sveltekit-reload class="focus-ring rounded border border-border px-2.5 py-1.5 text-xs font-semibold">Download copy</a>
                    {/if}
                    {#if output.remoteAvailable && !output.localAvailable}<button onclick={() => retryDownload(output.outputId)} disabled={pending !== null} class="focus-ring rounded border border-border px-2.5 py-1.5 text-xs font-semibold">Download again</button>{/if}
                    {#if output.remoteAvailable && output.mediaKind === 'image'}
                      <LinkButton href={`/studio/image?fromJob=${job.id}&sourceOutput=${output.outputId}`} variant="ghost">Remix image</LinkButton>
                      <LinkButton href={`/studio/video?fromJob=${job.id}&sourceOutput=${output.outputId}`} variant="ghost">Animate in Video Studio</LinkButton>
                    {:else if output.remoteAvailable}
                      <LinkButton href={`/studio/video?fromJob=${job.id}&sourceOutput=${output.outputId}`} variant="ghost">Remix video</LinkButton>
                    {/if}
                  </div>
                  <details class="mt-4 border-t border-border pt-3"><summary class="cursor-pointer text-xs font-semibold">Local deletion</summary><p class="mt-2 text-xs leading-5 text-muted-foreground">Removing metadata can leave an untracked file. No option here deletes remote Poyo data.</p><div class="mt-2 flex gap-2"><select aria-label={`Deletion consequence for output ${output.outputOrder + 1}`} value={deleteChoices[output.outputId] ?? 'file'} onchange={(event) => (deleteChoices[output.outputId] = event.currentTarget.value as LocalDeleteChoice)} class="focus-ring min-w-0 flex-1 rounded border border-input bg-background px-2 text-xs"><option value="file">File only</option><option value="metadata">Metadata only</option><option value="both">File + metadata</option></select><button onclick={() => removeOutput(output.outputId)} disabled={pending !== null} class="focus-ring rounded border border-destructive/40 px-2.5 text-xs font-semibold text-destructive">Remove</button></div></details>
                </div>
              </article>
            {/each}
          </div>
        {:else}<p class="mt-4 rounded bg-muted p-4 text-sm text-muted-foreground">No output records are available for this generation.</p>{/if}
      </section>

      <section aria-labelledby="history-heading" class="mt-8 border-t border-border pt-6">
        <div class="flex flex-wrap items-end justify-between gap-2"><div><p class="eyebrow-label">Lifecycle</p><h2 id="history-heading" class="mt-1 text-base font-semibold">Status history</h2></div><p class="text-xs text-muted-foreground">Showing {Math.min(visibleHistoryCount, job.history.length)} of {job.history.length}</p></div>
        <ol class="mt-4 space-y-0 border-l border-border pl-5">
          {#each visibleHistory as event (event.eventId)}<li class="relative pb-5"><span class="absolute top-1 -left-[1.47rem] size-2 rounded-full bg-border"></span><div class="flex flex-wrap items-baseline justify-between gap-2"><p class="text-sm font-semibold">{event.eventType.replaceAll('.', ' ')}</p><time class="text-xs text-muted-foreground" datetime={event.observedAt}>{dateTimeLabel(event.observedAt)}</time></div><p class="mt-1 text-xs text-muted-foreground">{event.authority === 'poyo' ? 'Poyo observation' : 'Local event'} · {event.localPhase} · {event.remoteStatus}{event.progress !== null ? ` · ${Math.round(event.progress)}%` : ''}</p></li>{/each}
        </ol>
        {#if visibleHistoryCount < job.history.length}<button type="button" class="focus-ring rounded border border-border px-3 py-2 text-xs font-semibold" onclick={() => (visibleHistoryCount += historyPageSize)}>Show 20 older events</button>{/if}
      </section>
    </main>

    <aside class="space-y-6">
      <section class="border-b border-border pb-5"><p class="eyebrow-label">Summary</p><dl class="mt-3 grid grid-cols-2 gap-4 text-xs"><div><dt class="text-muted-foreground">Created</dt><dd class="mt-1 font-medium">{dateTimeLabel(job.createdAt)}</dd></div><div><dt class="text-muted-foreground">Elapsed</dt><dd class="mt-1 font-medium">{elapsedLabel(job.startedAt ?? job.createdAt, job.completedAt)}</dd></div><div><dt class="text-muted-foreground">Credits</dt><dd class="mt-1 font-medium">{job.actualCredits ?? job.estimatedCredits ?? 'Unknown'}</dd></div><div><dt class="text-muted-foreground">Last check</dt><dd class="mt-1 font-medium">{job.lastPolledAt ? dateTimeLabel(job.lastPolledAt) : 'Never'}</dd></div></dl></section>
      <section class="border-b border-border pb-5"><p class="eyebrow-label">Organize</p><div class="mt-3 flex flex-wrap gap-2"><button onclick={() => toggle('favorite', !job.outputs.some((output) => output.favorite))} disabled={pending !== null} class="focus-ring inline-flex min-h-8 items-center gap-2 rounded border border-border px-3 text-xs font-semibold"><AppIcon name="heart" size={14} /> {job.outputs.some((output) => output.favorite) ? 'Unfavorite' : 'Favorite'}</button><button onclick={() => toggle('pin', !job.outputs.some((output) => output.pinned))} disabled={pending !== null} class="focus-ring min-h-8 rounded border border-border px-3 text-xs font-semibold">{job.outputs.some((output) => output.pinned) ? 'Unpin' : 'Pin'}</button></div><label class="mt-4 block text-xs font-semibold" for="job-tags">Tags, comma separated</label><div class="mt-2 flex gap-2"><input id="job-tags" bind:value={tags} class="focus-ring min-w-0 flex-1 rounded border border-input bg-background px-3 text-sm" /><button onclick={saveTags} disabled={pending !== null} class="focus-ring rounded border border-border px-3 text-xs font-semibold">Save</button></div></section>
      <section class="border-b border-border pb-5">
        <div class="flex items-center justify-between gap-2">
          <p class="eyebrow-label">Prompt</p>
          {#if job.prompt !== null}
            <button type="button" onclick={() => void copyPrompt()} class="focus-ring grid size-7 shrink-0 place-items-center rounded border border-border text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Copy full prompt" title="Copy full prompt"><AppIcon name={promptCopyStatus === 'Prompt copied.' ? 'success' : 'copy'} size={13} /></button>
          {/if}
        </div>
        <p id="job-prompt" class={`mt-3 break-all whitespace-pre-wrap text-sm leading-6 ${promptCanCollapse && !promptExpanded ? 'line-clamp-4' : ''}`}>{job.prompt ?? 'No prompt stored.'}</p>
        {#if promptCanCollapse}
          <button type="button" class="focus-ring mt-2 rounded text-xs font-semibold text-muted-foreground hover:text-foreground" aria-controls="job-prompt" aria-expanded={promptExpanded} onclick={() => (promptExpanded = !promptExpanded)}>{promptExpanded ? 'Show less' : 'Show full prompt'}</button>
        {/if}
        <p class="sr-only" role="status" aria-live="polite">{promptCopyStatus}</p>
      </section>
      {#if job.inputs.length}<section class="border-b border-border pb-5"><p class="eyebrow-label">Inputs</p><ul class="mt-3 space-y-3">{#each job.inputs as input}<li class="text-xs"><p class="font-semibold">{input.role} · {input.mediaKind}</p><p class="mt-1 break-all text-muted-foreground">{input.sourceLabel} · {input.availability}</p></li>{/each}</ul></section>{/if}
      <details class="border-b border-border pb-5"><summary class="cursor-pointer text-xs font-semibold">Submitted configuration</summary><pre class="mt-3 max-h-80 overflow-auto rounded bg-muted p-3 text-[0.6875rem] leading-5">{JSON.stringify(job.guidedRequest, null, 2)}</pre></details>
      <details class="border-b border-border pb-5"><summary class="cursor-pointer text-xs font-semibold">Normalized Poyo payload</summary><pre class="mt-3 max-h-80 overflow-auto rounded bg-muted p-3 text-[0.6875rem] leading-5">{JSON.stringify(job.normalizedPayload, null, 2)}</pre></details>
      <p class="text-xs leading-5 text-muted-foreground">Local job <code>{job.id}</code>{#if job.poyoTaskId}<br />Poyo task <code>{job.poyoTaskId}</code>{/if}<br />Correlation <code>{job.correlationId}</code></p>
    </aside>
  </div>
</div>
