<script lang="ts">
import Badge from '$lib/components/ui/Badge.svelte';
import Button from '$lib/components/ui/Button.svelte';
import LinkButton from '$lib/components/ui/LinkButton.svelte';
import Sheet from '$lib/components/ui/Sheet.svelte';
import {
  summarizeReadyBatchEstimates,
  summarizeSettledBatchCharges,
  type StudioBatchItem
} from '$lib/features/generation/studio-batch';

interface Props {
  modality: 'image' | 'video';
  items: StudioBatchItem[];
  submitting: boolean;
  canSubmit: boolean;
  addLabel: string;
  addDisabled: boolean;
  onadd: () => void;
  onedit: (item: StudioBatchItem) => void;
  onduplicate: (item: StudioBatchItem) => void;
  onremove: (item: StudioBatchItem) => void;
  onsubmit: () => void;
  onretry: (item: StudioBatchItem) => void;
  onreconcile: (item: StudioBatchItem) => void;
  onabandon: (item: StudioBatchItem) => void;
}

let {
  modality,
  items,
  submitting,
  canSubmit,
  addLabel,
  addDisabled,
  onadd,
  onedit,
  onduplicate,
  onremove,
  onsubmit,
  onretry,
  onreconcile,
  onabandon
}: Props = $props();
let open = $state(false);
let draftCount = $derived(items.filter((item) => item.state === 'draft').length);
let settledCount = $derived(items.filter((item) => item.state === 'complete').length);
let readyEstimate = $derived(summarizeReadyBatchEstimates(items));
let settledCharges = $derived(summarizeSettledBatchCharges(items));

function tone(item: StudioBatchItem): 'neutral' | 'info' | 'success' | 'warning' {
  if (item.state === 'complete') return 'success';
  if (item.state === 'failed' || item.state === 'unknown' || item.state === 'invalid')
    return 'warning';
  if (['submitting', 'queued', 'running', 'downloading'].includes(item.state)) return 'info';
  return 'neutral';
}

function summary(item: StudioBatchItem): string {
  const prompt = item.request.values.prompt;
  const ratio = item.request.values.aspectRatio;
  const resolution = item.request.values.resolution;
  return [typeof prompt === 'string' ? prompt : 'Media-driven request', ratio, resolution]
    .filter(Boolean)
    .join(' · ');
}
</script>

<div
  role="group"
  aria-label="Batch commands"
  class="grid grid-cols-2 gap-1 rounded-[var(--radius)] border border-border bg-muted p-1"
>
  <Button size="sm" variant="outline" class="w-full" disabled={addDisabled} onclick={onadd}>
    {addLabel}
  </Button>
  <Sheet
    bind:open
    title={`${modality === 'image' ? 'Image' : 'Video'} batch`}
    description="Review locally coordinated items before Poyo receives separate jobs."
    side="right"
    triggerClass="focus-ring inline-flex min-h-8 w-full items-center justify-center gap-2 rounded-[var(--radius)] border border-border bg-background px-2.5 text-xs font-semibold shadow-[var(--shadow-xs)] hover:bg-muted"
    contentClass="flex h-full w-[min(100vw,34rem)] flex-col"
  >
    {#snippet trigger()}Review batch ({items.length}){/snippet}
    <div class="flex min-h-0 flex-1 flex-col">
    <div class="border-b border-border px-5 py-3 text-xs leading-5 text-muted-foreground">
      <p>Local batch · sequential submission · each item remains an independent recoverable job.</p>
      <p class="mt-1">Each submitted item is a separate billed Poyo job. Exact credits appear only after completion.</p>
      <p class="mt-1">{settledCount} complete · {draftCount} ready to submit</p>
      <p class="mt-1">
        Estimated ready batch:
        {readyEstimate.credits === null
          ? 'unavailable'
          : `${readyEstimate.credits} credits`}
        · {readyEstimate.itemCount} item{readyEstimate.itemCount === 1 ? '' : 's'}
      </p>
      <p class="mt-1">
        Actual batch total:
        {settledCharges.actionCount === 0
          ? 'no settled Poyo task charges'
          : `${settledCharges.credits} credits · ${settledCharges.actionCount} settled Poyo task${settledCharges.actionCount === 1 ? '' : 's'}`}
      </p>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      {#if items.length}
        <ol class="grid list-none gap-3 p-0">
          {#each items as item, index (item.id)}
            <li class="rounded-[var(--radius)] border border-border bg-card p-3">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <p class="text-xs font-semibold text-muted-foreground">Item {index + 1}</p>
                  <h3 class="mt-0.5 truncate text-sm font-semibold">{item.displayName}</h3>
                </div>
                <Badge tone={tone(item)}>{item.state.replaceAll('_', ' ')}</Badge>
              </div>
              <p class="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">{summary(item)}</p>
              {#if item.job?.taskCharge}
                <p class="mt-1 text-xs font-medium">
                  Charged {item.job.taskCharge.credits} credits · Poyo task
                </p>
              {:else if item.estimate?.availability === 'available'}
                <p class="mt-1 text-xs text-muted-foreground">
                  Estimated credits: {item.estimate.credits} · {item.estimate.provenance} · {item.estimate.freshness}
                </p>
              {:else}
                <p class="mt-1 text-xs text-muted-foreground">Estimated credits unavailable</p>
              {/if}
              {#if item.job?.progress !== null && item.job?.progress !== undefined && item.state !== 'complete'}
                <div class="mt-2">
                  <div class="flex justify-between text-[0.6875rem] text-muted-foreground"><span>Reported progress</span><span>{item.job.progress}%</span></div>
                  <progress class="mt-1 h-1.5 w-full accent-primary" max="100" value={item.job.progress}>{item.job.progress}%</progress>
                </div>
              {/if}
              {#if item.outputs.some((output) => output.mediaUrl)}
                <div class="mt-3 flex gap-2 overflow-x-auto">
                  {#each item.outputs.filter((output) => output.mediaUrl) as output (output.outputId)}
                    <a href={output.mediaUrl ?? '#'} target="_blank" rel="noopener" class="focus-ring block size-20 shrink-0 overflow-hidden rounded border border-border bg-stage" aria-label={`Open result for batch item ${index + 1}`}>
                      {#if output.mediaKind === 'video'}
                        <!-- svelte-ignore a11y_media_has_caption -->
                        <video src={output.mediaUrl ?? ''} muted class="size-full object-contain"></video>
                      {:else}
                        <img src={output.mediaUrl ?? ''} alt={`Generated result for batch item ${index + 1}`} class="size-full object-contain" />
                      {/if}
                    </a>
                  {/each}
                </div>
              {/if}
              {#if item.error}<p class="mt-2 text-xs leading-5 text-destructive">{item.error}</p>{/if}
              <div class="mt-3 flex flex-wrap gap-1.5">
                {#if item.state === 'draft' || item.state === 'invalid'}
                  <Button size="sm" variant="outline" onclick={() => onedit(item)}>Edit</Button>
                  <Button size="sm" variant="ghost" onclick={() => onduplicate(item)}>Duplicate</Button>
                {/if}
                {#if item.state === 'unknown'}
                  <Button size="sm" variant="outline" onclick={() => onreconcile(item)}>Check action</Button>
                  <Button size="sm" variant="ghost" onclick={() => onabandon(item)}>Abandon action</Button>
                {/if}
                {#if item.state === 'failed'}
                  <Button size="sm" variant="outline" onclick={() => onretry(item)}>Retry item</Button>
                {/if}
                {#if item.job}
                  <LinkButton href={`/jobs?selected=${item.job.id}`} variant="ghost">View job</LinkButton>
                {/if}
                {#if item.state !== 'submitting' && item.state !== 'unknown'}
                  <Button size="sm" variant="ghost" onclick={() => onremove(item)}>Remove</Button>
                {/if}
              </div>
            </li>
          {/each}
        </ol>
      {:else}
        <div class="rounded-[var(--radius)] bg-muted px-4 py-8 text-center">
          <p class="text-sm font-semibold">No batch items yet</p>
          <p class="mt-1 text-xs leading-5 text-muted-foreground">Close this panel, prepare a valid setup, then add it to the batch.</p>
        </div>
      {/if}
    </div>
    <div class="border-t border-border px-5 py-4">
      <Button variant="primary" class="w-full" disabled={!draftCount || submitting || !canSubmit} onclick={onsubmit}>
        {submitting ? 'Submitting billed jobs in order…' : `Submit ${draftCount} separate billed job${draftCount === 1 ? '' : 's'}`}
      </Button>
      {#if !canSubmit}<p class="mt-2 text-center text-xs text-muted-foreground">Configure a Poyo API key before submitting this batch.</p>{/if}
    </div>
    </div>
  </Sheet>
</div>
