<script lang="ts">
import MediaPreview from '$lib/components/library/MediaPreview.svelte';
import StatusBadge from '$lib/components/library/StatusBadge.svelte';
import { attentionDescription } from '$lib/features/library/presentation';
import AppIcon from '$lib/components/ui/AppIcon.svelte';
import Badge from '$lib/components/ui/Badge.svelte';
import LinkButton from '$lib/components/ui/LinkButton.svelte';
import { byteSizeLabel, dateTimeLabel } from '$lib/features/library/presentation';
import type { PageData } from './$types';

let { data }: { data: PageData } = $props();
</script>

<svelte:head>
  <title>Dashboard · Poyo Local Studio</title>
  <meta name="description" content="Local Poyo account, jobs, media and application health." />
</svelte:head>

<div class="route-shell">
  <div class="mb-5 flex flex-wrap items-center justify-between gap-3">
    <div><p class="eyebrow-label">Local overview</p><p class="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">Account snapshots, durable work and verified local media.</p></div>
    <div class="flex gap-2"><LinkButton href="/studio/image" variant="primary"><AppIcon name="image" size={16} /> New image</LinkButton><LinkButton href="/studio/video" variant="outline"><AppIcon name="video" size={16} /> New video</LinkButton></div>
  </div>

  <section aria-labelledby="overview-heading" class="border-y border-border py-4">
    <h2 id="overview-heading" class="sr-only">System overview</h2>
    <dl class="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-5">
      <div><dt class="text-xs text-muted-foreground">Poyo balance</dt><dd class="mt-1 flex items-center gap-2 text-sm font-semibold"><AppIcon name="wallet" size={15} /> {data.dashboard.balance ? `${data.dashboard.balance.credits.toLocaleString()} credits` : 'Not refreshed'}</dd>{#if data.dashboard.balance}<dd class="mt-1 text-[0.6875rem] text-muted-foreground">As of {dateTimeLabel(data.dashboard.balance.fetchedAt)}</dd>{/if}</div>
      <div><dt class="text-xs text-muted-foreground">Active and queued</dt><dd class="mt-1 text-sm font-semibold">{data.dashboard.active.length} jobs</dd></div>
      <div><dt class="text-xs text-muted-foreground">Local storage</dt><dd class="mt-1 text-sm font-semibold">{byteSizeLabel(data.dashboard.storage.indexedBytes)}</dd><dd class="mt-1 text-[0.6875rem] text-muted-foreground">{data.dashboard.storage.verifiedFiles} verified files</dd></div>
      <div><dt class="text-xs text-muted-foreground">Model registry</dt><dd class="mt-1"><Badge tone="success">{data.dashboard.registry.imageWorkflows + data.dashboard.registry.videoWorkflows} workflows</Badge></dd></div>
      <div><dt class="text-xs text-muted-foreground">Application health</dt><dd class="mt-1"><Badge tone={data.dashboard.health.status === 'ok' ? 'success' : 'warning'}>{data.dashboard.health.status}</Badge></dd><dd class="mt-1 text-[0.6875rem] text-muted-foreground">API key {data.dashboard.health.apiKeyStatus}</dd></div>
    </dl>
  </section>

  <div class="mt-7 grid gap-8 xl:grid-cols-[minmax(0,1fr)_19rem]">
    <section aria-labelledby="work-heading">
      <div class="flex items-center justify-between gap-3 border-b border-border pb-3"><div><p class="eyebrow-label">Now</p><h2 id="work-heading" class="mt-1 text-base font-semibold">Work in progress</h2></div><a class="focus-ring rounded text-xs font-semibold text-primary hover:underline" href="/jobs">View all jobs</a></div>
      {#if data.dashboard.active.length}<div class="divide-y divide-border">{#each data.dashboard.active as job}<a href={`/jobs/${job.id}`} class="focus-ring grid gap-2 py-4 no-underline sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"><div class="min-w-0"><div class="flex flex-wrap items-center gap-2"><span class="truncate text-sm font-semibold">{job.displayName}</span><StatusBadge localPhase={job.localPhase} remoteStatus={job.remoteStatus} attentionCode={job.attentionCode} /></div><p class="mt-1 truncate text-xs text-muted-foreground">{job.promptExcerpt ?? job.workflow}</p></div><span class="text-xs font-medium text-muted-foreground">{job.progress === null ? 'Real state only' : `${Math.round(job.progress)}%`}</span></a>{/each}</div>
      {:else}<div class="py-12"><AppIcon name="activity" size={22} class="text-muted-foreground" /><h3 class="mt-3 text-base font-semibold">No work in progress</h3><p class="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">Submitted jobs persist here across navigation, refreshes and local server restarts.</p></div>{/if}
    </section>

    <aside aria-labelledby="attention-heading" class="border-t border-border pt-5 xl:border-t-0 xl:border-l xl:pl-6">
      <p class="eyebrow-label">Review</p><h2 id="attention-heading" class="mt-1 text-base font-semibold">Needs attention</h2>
      {#if data.dashboard.attention.length}<ul class="mt-4 space-y-4">{#each data.dashboard.attention as job}<li><a href={`/jobs/${job.id}`} class="focus-ring block rounded text-sm font-semibold hover:underline">{job.displayName}</a><p class="mt-1 text-xs leading-5 text-muted-foreground">{attentionDescription(job.attentionCode, job.ipGuardReason ?? null, job.failureDomain === 'poll')}</p></li>{/each}</ul>
      {:else}<div class="mt-4 flex items-start gap-3 text-sm"><AppIcon name="success" size={17} class="mt-0.5 text-success" /><div><p class="font-semibold">Nothing needs attention</p><p class="mt-1 leading-5 text-muted-foreground">Failures and interrupted local work appear here.</p></div></div>{/if}
    </aside>
  </div>

  <section aria-labelledby="recent-heading" class="mt-8 border-t border-border pt-5">
    <div class="flex items-center justify-between gap-4"><div><p class="eyebrow-label">Recent</p><h2 id="recent-heading" class="mt-1 text-base font-semibold">Recent generations</h2></div><a class="focus-ring rounded text-xs font-semibold text-primary hover:underline" href="/library">Open library</a></div>
    {#if data.dashboard.recent.length}<div class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{#each data.dashboard.recent as group}<a href={`/library/${group.jobId}`} class="group focus-ring overflow-hidden rounded-lg border border-border bg-card no-underline"><MediaPreview mediaKind={group.representative?.mediaKind ?? group.modality} src={group.representative?.mediaUrl ?? null} alt={`Preview for ${group.displayName}`} fit="contain" class="aspect-[4/3]" /><div class="p-2.5"><p class="truncate text-xs font-semibold">{group.displayName}</p><p class="mt-0.5 truncate text-[0.6875rem] text-muted-foreground">{group.promptExcerpt ?? group.workflow}</p></div></a>{/each}</div>
    {:else}<div class="mt-4 rounded-lg bg-muted px-5 py-8 text-center"><p class="text-sm text-muted-foreground">Verified local images and videos will appear here as grouped generations.</p></div>{/if}
  </section>
</div>
