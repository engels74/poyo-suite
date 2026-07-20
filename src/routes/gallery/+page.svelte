<script lang="ts">
import { invalidateAll } from '$app/navigation';
import GalleryViewer from '$lib/components/gallery/GalleryViewer.svelte';
import MediaPreview from '$lib/components/library/MediaPreview.svelte';
import AppIcon from '$lib/components/ui/AppIcon.svelte';
import Badge from '$lib/components/ui/Badge.svelte';
import LinkButton from '$lib/components/ui/LinkButton.svelte';
import {
  byteSizeLabel,
  dateTimeLabel,
  mediaFrameAspectRatio
} from '$lib/features/library/presentation';
import type { PageData } from './$types';

let { data }: { data: PageData } = $props();
let pendingFavorite = $state<string | null>(null);
let favoriteFeedback = $state('');
let viewerOpen = $state(false);
let selectedOutputId = $state<string | null>(null);
let viewerTrigger = $state<HTMLElement | null>(null);

function openViewer(event: MouseEvent & { currentTarget: HTMLButtonElement }): void {
  const outputId = event.currentTarget.dataset.outputId;
  if (!outputId) return;
  selectedOutputId = outputId;
  viewerTrigger = event.currentTarget;
  viewerOpen = true;
}

function href(overrides: Record<string, string | boolean | null>): string {
  const query = new URLSearchParams();
  const values: Record<string, string | boolean> = {
    q: data.filters.q,
    kind: data.filters.mediaKind,
    model: data.filters.model,
    provider: data.filters.provider,
    workflow: data.filters.workflow,
    aspect: data.filters.aspectRatio,
    status: data.filters.status === 'all' ? '' : data.filters.status,
    favorite: data.filters.favorite,
    tag: data.filters.tag,
    from: data.filters.dateFrom,
    to: data.filters.dateTo,
    view: data.filters.view
  };
  Object.assign(values, overrides);
  for (const [key, value] of Object.entries(values))
    if (value && value !== 'all') query.set(key, String(value));
  return query.size ? `/gallery?${query}` : '/gallery';
}

async function setFavorite(jobId: string, favorite: boolean): Promise<void> {
  pendingFavorite = jobId;
  favoriteFeedback = '';
  try {
    const response = await fetch(`/api/library/${jobId}/favorite`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ favorite })
    });
    if (!response.ok) throw new Error('Favorite update failed.');
    await invalidateAll();
  } catch {
    favoriteFeedback = 'Favorite update failed.';
  } finally {
    pendingFavorite = null;
  }
}
</script>

<svelte:head>
  <title>Gallery · Poyo Local Studio</title>
  <meta name="description" content="Browse verified local image and video generations." />
</svelte:head>

<div class="route-shell">
  <section aria-labelledby="gallery-heading">
    <div class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <p class="eyebrow-label">Local media</p>
        <h2 id="gallery-heading" class="mt-1 text-xl font-semibold tracking-tight">Generation gallery</h2>
        <p class="mt-2 text-sm leading-6 text-muted-foreground">
          {data.page.total} grouped {data.page.total === 1 ? 'generation' : 'generations'} · {byteSizeLabel(data.storage.indexedBytes)} indexed locally
        </p>
      </div>
      <div class="flex items-center gap-1 rounded bg-muted p-1" aria-label="Gallery view">
        <a href={href({ view: 'grid', cursor: null })} class="focus-ring grid size-8 place-items-center rounded" class:bg-background={data.filters.view === 'grid'} aria-label="Grid view" aria-current={data.filters.view === 'grid' ? 'page' : undefined}><AppIcon name="grid" size={16} /></a>
        <a href={href({ view: 'list', cursor: null })} class="focus-ring grid size-8 place-items-center rounded" class:bg-background={data.filters.view === 'list'} aria-label="List view" aria-current={data.filters.view === 'list' ? 'page' : undefined}><AppIcon name="list" size={16} /></a>
      </div>
    </div>

    <form method="GET" class="mt-5 grid gap-2 border-y border-border py-3 md:grid-cols-[minmax(14rem,1fr)_9rem_11rem_10rem_9rem_auto]">
      <input type="hidden" name="view" value={data.filters.view} />
      <label class="relative"><span class="sr-only">Search local media</span><AppIcon name="search" size={15} class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground" /><input name="q" value={data.filters.q} class="focus-ring h-9 w-full rounded border border-input bg-background pr-3 pl-9 text-sm" placeholder="Prompt, filename, model or tag" /></label>
      <label><span class="sr-only">Media kind</span><select name="kind" class="focus-ring h-9 w-full rounded border border-input bg-background px-2 text-sm"><option value="">Images + video</option><option value="image" selected={data.filters.mediaKind === 'image'}>Images</option><option value="video" selected={data.filters.mediaKind === 'video'}>Videos</option></select></label>
      <label><span class="sr-only">Provider</span><select name="provider" class="focus-ring h-9 w-full rounded border border-input bg-background px-2 text-sm"><option value="">All providers</option>{#each data.filterOptions.providers as provider}<option value={provider} selected={data.filters.provider === provider}>{provider}</option>{/each}</select></label>
      <label><span class="sr-only">Workflow</span><select name="workflow" class="focus-ring h-9 w-full rounded border border-input bg-background px-2 text-sm"><option value="">All workflows</option>{#each data.filterOptions.workflows as workflow}<option value={workflow} selected={data.filters.workflow === workflow}>{workflow}</option>{/each}</select></label>
      <label><span class="sr-only">Availability</span><select name="status" class="focus-ring h-9 w-full rounded border border-input bg-background px-2 text-sm"><option value="all">Any status</option><option value="available" selected={data.filters.status === 'available'}>Available locally</option><option value="attention" selected={data.filters.status === 'attention'}>Needs attention</option><option value="remote-only" selected={data.filters.status === 'remote-only'}>Remote only</option><option value="deleted" selected={data.filters.status === 'deleted'}>Deleted</option></select></label>
      <button class="focus-ring min-h-9 rounded bg-primary px-3 text-sm font-semibold text-primary-foreground" type="submit">Filter</button>
      <div class="flex flex-wrap gap-2 md:col-span-full">
        <a href={href({ favorite: !data.filters.favorite, cursor: null })} class="focus-ring inline-flex min-h-8 items-center gap-2 rounded border border-border px-3 text-xs font-semibold" aria-current={data.filters.favorite ? 'page' : undefined}><AppIcon name="heart" size={14} /> Favorites</a>
        {#each data.filterOptions.tags as tag}<a href={href({ tag: data.filters.tag === tag ? '' : tag, cursor: null })} class="focus-ring rounded-full bg-muted px-3 py-1 text-xs font-medium">{tag}</a>{/each}
        <a href={`/gallery?view=${data.filters.view}`} class="focus-ring ml-auto rounded px-2 py-1 text-xs font-semibold text-muted-foreground hover:text-foreground">Clear filters</a>
      </div>
    </form>

    {#if favoriteFeedback}<p class="mt-4 rounded border border-border bg-muted px-4 py-3 text-sm" role="status">{favoriteFeedback}</p>{/if}

    {#if data.page.items.length}
      <div class={data.filters.view === 'grid' ? 'mt-5 grid gap-5 sm:grid-cols-2 xl:grid-cols-3' : 'mt-3 divide-y divide-border'}>
        {#each data.page.items as group (group.jobId)}
          {@const representative = group.representative}
          {@const mediaKind = representative?.mediaKind ?? group.modality}
          {@const mediaKindLabel = mediaKind === 'video' ? 'Video' : 'Image'}
          {@const viewerLabel = `View ${mediaKind} ${group.displayName}`}
          <article class={data.filters.view === 'grid' ? 'group overflow-hidden rounded-lg border border-border bg-card shadow-[var(--shadow-xs)]' : 'grid gap-3 py-4 sm:grid-cols-[9rem_minmax(0,1fr)_auto] sm:items-center'}>
            {#if representative?.mediaUrl}
              <button type="button" onclick={openViewer} class="focus-ring block w-full overflow-hidden rounded text-left" aria-label={viewerLabel} data-output-id={representative.outputId}>
                <div
                  style={`aspect-ratio: ${data.filters.view === 'grid' ? mediaFrameAspectRatio(representative.pixelWidth, representative.pixelHeight, group.aspectRatio) : '16 / 9'};`}
                >
                  <MediaPreview mediaKind={representative.mediaKind} src={representative.mediaUrl} alt={`Preview for ${group.displayName}`} fit="contain" preload="none" class="size-full" />
                </div>
              </button>
            {:else}
              <div
                style={`aspect-ratio: ${data.filters.view === 'grid' ? mediaFrameAspectRatio(group.representative?.pixelWidth ?? null, group.representative?.pixelHeight ?? null, group.aspectRatio) : '16 / 9'};`}
              >
                <MediaPreview mediaKind={group.representative?.mediaKind ?? group.modality} src={group.representative?.mediaUrl ?? null} alt={`Preview for ${group.displayName}`} fit="contain" class="size-full" />
              </div>
            {/if}
            <div class={data.filters.view === 'grid' ? 'p-4' : 'min-w-0'}>
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">{#if representative?.mediaUrl}<button type="button" onclick={openViewer} class="focus-ring block max-w-full truncate rounded text-left text-sm font-semibold hover:underline" aria-label={viewerLabel} data-output-id={representative.outputId}>{group.displayName}</button>{:else}<p class="truncate text-sm font-semibold">{group.displayName}</p>{/if}<p class="mt-1 truncate text-xs text-muted-foreground">{group.provider} · {group.workflow}</p></div>
                <button onclick={() => setFavorite(group.jobId, !group.favorite)} disabled={pendingFavorite === group.jobId} class="focus-ring shrink-0 rounded p-1.5" class:text-destructive={group.favorite} aria-label={group.favorite ? 'Remove from favorites' : 'Add to favorites'} aria-pressed={group.favorite}><AppIcon name="heart" size={16} /></button>
              </div>
              <p class="mt-3 line-clamp-2 min-h-10 text-sm leading-5 text-muted-foreground">{group.promptExcerpt ?? 'No prompt stored'}</p>
              <div class="mt-3 flex flex-wrap items-center gap-2"><Badge>{mediaKindLabel}</Badge><Badge tone={group.warning ? 'warning' : 'success'}>{group.verifiedOutputCount}/{group.outputCount} local</Badge>{#if group.aspectRatio}<Badge>{group.aspectRatio}</Badge>{/if}{#if group.pinned}<Badge tone="info">Pinned</Badge>{/if}</div>
              {#if group.warning}<p class="mt-2 text-xs font-semibold text-warning">{group.warning}</p>{/if}
              {#if !representative?.mediaUrl}<a href={`/jobs/${group.jobId}`} class="focus-ring mt-3 inline-flex rounded text-xs font-semibold text-primary hover:underline">Open job</a>{/if}
              <div class="mt-3 flex flex-wrap gap-1">{#each group.tags as tag}<span class="rounded-full bg-muted px-2 py-0.5 text-[0.6875rem]">{tag}</span>{/each}</div>
              <p class="mt-3 text-xs text-muted-foreground"><time datetime={group.createdAt}>{dateTimeLabel(group.createdAt)}</time> · {byteSizeLabel(group.totalBytes)}</p>
            </div>
            {#if data.filters.view === 'list' && representative?.mediaUrl}<button type="button" onclick={openViewer} class="focus-ring rounded p-2" aria-label={viewerLabel} data-output-id={representative.outputId}><AppIcon name="chevron-right" size={17} /></button>{/if}
          </article>
        {/each}
      </div>
      {#if data.page.nextCursor}<div class="mt-5 border-t border-border pt-4"><LinkButton href={href({ cursor: data.page.nextCursor })} variant="outline">Next page <AppIcon name="arrow-right" size={15} /></LinkButton></div>{/if}
    {:else}
      <div class="grid min-h-80 place-items-center py-12 text-center"><div class="max-w-md"><AppIcon name="library" size={25} class="mx-auto text-muted-foreground" /><h3 class="mt-4 text-base font-semibold">No matching generations</h3><p class="mt-2 text-sm leading-6 text-muted-foreground">Successful outputs are downloaded, verified and grouped in this gallery. Adjust the filters or create new media.</p><div class="mt-5"><LinkButton href="/studio/image" variant="primary">Create media</LinkButton></div></div></div>
    {/if}
  </section>
</div>

<GalleryViewer
  groups={data.page.items}
  bind:open={viewerOpen}
  bind:selectedOutputId
  bind:triggerElement={viewerTrigger}
/>
