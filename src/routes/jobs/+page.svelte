<script lang="ts">
import { onMount } from 'svelte';
import { invalidateAll } from '$app/navigation';
import StatusBadge from '$lib/components/library/StatusBadge.svelte';
import AppIcon from '$lib/components/ui/AppIcon.svelte';
import LinkButton from '$lib/components/ui/LinkButton.svelte';
import { nextMonotonicEventId } from '$lib/features/generation/studio-controller';
import { dateTimeLabel, elapsedLabel } from '$lib/features/library/presentation';
import type { PageData } from './$types';

let { data }: { data: PageData } = $props();
let connection = $state<'connecting' | 'connected' | 'disconnected'>('connecting');
let lastEventId = -1;

const statusFilters = [
  ['all', 'All'],
  ['queued', 'Queued'],
  ['running', 'Running'],
  ['completed', 'Completed'],
  ['failed', 'Failed'],
  ['attention', 'Needs attention'],
  ['stale', 'Stale']
] as const;

function filterHref(status: string): string {
  const query = new URLSearchParams();
  if (status !== 'all') query.set('status', status);
  for (const key of ['q', 'model', 'workflow', 'from', 'to'] as const) {
    const value =
      key === 'from'
        ? data.filters.dateFrom
        : key === 'to'
          ? data.filters.dateTo
          : data.filters[key];
    if (value) query.set(key, value);
  }
  return query.size ? `/jobs?${query}` : '/jobs';
}

function nextHref(): string {
  const query = new URLSearchParams();
  if (data.filters.status !== 'all') query.set('status', data.filters.status);
  if (data.filters.q) query.set('q', data.filters.q);
  if (data.filters.model) query.set('model', data.filters.model);
  if (data.filters.workflow) query.set('workflow', data.filters.workflow);
  if (data.filters.dateFrom) query.set('from', data.filters.dateFrom);
  if (data.filters.dateTo) query.set('to', data.filters.dateTo);
  if (data.page.nextCursor) query.set('cursor', data.page.nextCursor);
  return `/jobs?${query}`;
}

function acceptDurableEvent(event: MessageEvent<string>): boolean {
  const next = nextMonotonicEventId(lastEventId, event.lastEventId);
  if (next === null) return false;
  lastEventId = next;
  return true;
}

onMount(() => {
  const events = new EventSource('/api/events/jobs');
  events.addEventListener('open', () => (connection = 'connected'));
  events.addEventListener('snapshot', (event) => {
    if (!acceptDurableEvent(event as MessageEvent<string>)) return;
    connection = 'connected';
  });
  events.addEventListener('job', (event) => {
    if (!acceptDurableEvent(event as MessageEvent<string>)) return;
    connection = 'connected';
    void invalidateAll();
  });
  events.addEventListener('error', () => (connection = 'disconnected'));
  return () => events.close();
});
</script>

<svelte:head>
  <title>Jobs · Poyo Local Studio</title>
  <meta name="description" content="Inspect durable local jobs and their Poyo task lifecycle." />
</svelte:head>

<div class="route-shell">
  <section aria-labelledby="jobs-heading">
    <div class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <p class="eyebrow-label">Durable queue</p>
        <h2 id="jobs-heading" class="mt-1 text-xl font-semibold tracking-tight">Generation history</h2>
        <p class="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          {data.page.total} tracked {data.page.total === 1 ? 'job' : 'jobs'}. Local work and Poyo state remain separate.
        </p>
      </div>
      <span class="inline-flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
        <span class:animate-pulse={connection === 'connecting'} class="size-2 rounded-full bg-current"></span>
        Live updates {connection}
      </span>
    </div>

    <nav class="mt-5 flex gap-1 overflow-x-auto border-b border-border pb-px" aria-label="Job status filters">
      {#each statusFilters as [value, label] (value)}
        <a
          href={filterHref(value)}
          class="focus-ring -mb-px whitespace-nowrap border-b-2 px-3 py-2 text-xs font-semibold no-underline"
          class:border-primary={data.filters.status === value}
          class:text-foreground={data.filters.status === value}
          class:border-transparent={data.filters.status !== value}
          class:text-muted-foreground={data.filters.status !== value}
          aria-current={data.filters.status === value ? 'page' : undefined}
        >{label}</a>
      {/each}
    </nav>

    <form method="GET" class="grid gap-2 border-b border-border py-3 md:grid-cols-[minmax(12rem,1fr)_12rem_11rem_8.5rem_8.5rem_auto]">
      {#if data.filters.status !== 'all'}<input type="hidden" name="status" value={data.filters.status} />{/if}
      <label class="relative">
        <span class="sr-only">Search jobs</span>
        <AppIcon name="search" size={15} class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground" />
        <input name="q" value={data.filters.q} class="focus-ring h-9 w-full rounded border border-input bg-background pr-3 pl-9 text-sm" placeholder="Search prompt or model" />
      </label>
      <label><span class="sr-only">Model</span><select name="model" class="focus-ring h-9 w-full rounded border border-input bg-background px-2 text-sm"><option value="">All models</option>{#each data.filterOptions.models as model (`${model.publicModelId}:${model.workflow}`)}<option value={model.publicModelId} selected={data.filters.model === model.publicModelId}>{model.displayName}</option>{/each}</select></label>
      <label><span class="sr-only">Workflow</span><select name="workflow" class="focus-ring h-9 w-full rounded border border-input bg-background px-2 text-sm"><option value="">All workflows</option>{#each data.filterOptions.workflows as workflow}<option value={workflow} selected={data.filters.workflow === workflow}>{workflow}</option>{/each}</select></label>
      <label><span class="sr-only">From date</span><input type="date" name="from" value={data.filters.dateFrom} class="focus-ring h-9 w-full rounded border border-input bg-background px-2 text-xs" /></label>
      <label><span class="sr-only">To date</span><input type="date" name="to" value={data.filters.dateTo} class="focus-ring h-9 w-full rounded border border-input bg-background px-2 text-xs" /></label>
      <button class="focus-ring min-h-9 rounded bg-primary px-3 text-sm font-semibold text-primary-foreground" type="submit">Filter</button>
    </form>

    {#if data.page.items.length}
      <div class="divide-y divide-border" aria-live="polite">
        {#each data.page.items as job (job.id)}
          <article class="grid gap-3 py-4 lg:grid-cols-[minmax(0,1.5fr)_9rem_10rem_8rem_1.5rem] lg:items-center">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <a href={`/jobs/${job.id}`} class="focus-ring truncate rounded text-sm font-semibold hover:underline">{job.displayName}</a>
                <StatusBadge localPhase={job.localPhase} remoteStatus={job.remoteStatus} attentionCode={job.attentionCode} />
              </div>
              <p class="mt-1 truncate text-xs text-muted-foreground">{job.promptExcerpt ?? 'No prompt stored'} · {job.workflow}</p>
            </div>
            <dl class="grid grid-cols-2 gap-3 text-xs lg:block">
              <div><dt class="text-muted-foreground">Started</dt><dd class="mt-1 font-medium"><time datetime={job.createdAt}>{dateTimeLabel(job.createdAt)}</time></dd></div>
            </dl>
            <div class="text-xs"><p class="text-muted-foreground">Elapsed / progress</p><p class="mt-1 font-medium">{elapsedLabel(job.startedAt ?? job.createdAt, job.completedAt)}{job.progress !== null ? ` · ${Math.round(job.progress)}%` : ''}</p></div>
            <div class="text-xs"><p class="text-muted-foreground">Outputs / cost</p><p class="mt-1 font-medium">{job.verifiedOutputCount}/{job.outputCount} local · {job.actualCredits ?? job.estimatedCredits ?? '—'} cr</p></div>
            <a class="focus-ring hidden rounded p-1 lg:block" href={`/jobs/${job.id}`} aria-label={`Open ${job.displayName} job`}><AppIcon name="chevron-right" size={16} /></a>
          </article>
        {/each}
      </div>
      {#if data.page.nextCursor}<div class="border-t border-border pt-4"><LinkButton href={nextHref()} variant="outline">Next page <AppIcon name="arrow-right" size={15} /></LinkButton></div>{/if}
    {:else}
      <div class="py-14 text-center">
        <AppIcon name="jobs" size={24} class="mx-auto text-muted-foreground" />
        <h3 class="mt-3 text-base font-semibold">No matching jobs</h3>
        <p class="mt-2 text-sm text-muted-foreground">Adjust the filters or submit a new generation.</p>
        <div class="mt-5 flex justify-center gap-2"><LinkButton href="/studio/image" variant="primary">Open Image Studio</LinkButton><LinkButton href="/studio/video" variant="outline">Open Video Studio</LinkButton></div>
      </div>
    {/if}
  </section>
</div>
