<script lang="ts">
import { Dialog } from 'bits-ui';
import type { LibraryGroupDto, SafeMediaSummary } from '$lib/features/library/contracts';
import { dateTimeLabel } from '$lib/features/library/presentation';

type ViewableGroup = LibraryGroupDto & {
  representative: SafeMediaSummary & { mediaUrl: string };
};

interface Props {
  groups: LibraryGroupDto[];
  open?: boolean;
  selectedOutputId?: string | null;
  triggerElement?: HTMLElement | null;
}

let {
  groups,
  open = $bindable(false),
  selectedOutputId = $bindable<string | null>(null),
  triggerElement = $bindable<HTMLElement | null>(null)
}: Props = $props();

let activeVideo = $state<HTMLVideoElement | null>(null);
let viewableGroups = $derived(groups.filter(isViewable));
let activeIndex = $derived(
  viewableGroups.findIndex((group) => group.representative.outputId === selectedOutputId)
);
let activeGroup = $derived(activeIndex >= 0 ? viewableGroups[activeIndex] : null);
let canGoPrevious = $derived(activeIndex > 0);
let canGoNext = $derived(activeIndex >= 0 && activeIndex < viewableGroups.length - 1);

function isViewable(group: LibraryGroupDto): group is ViewableGroup {
  return Boolean(group.representative?.mediaUrl);
}

function moveSelection(delta: -1 | 1): void {
  const nextIndex = activeIndex + delta;
  if (nextIndex < 0 || nextIndex >= viewableGroups.length) return;
  const nextGroup = viewableGroups[nextIndex];
  if (!nextGroup) return;
  activeVideo?.pause();
  selectedOutputId = nextGroup.representative.outputId;
}

function ignoresArrowShortcut(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLVideoElement ||
    target instanceof HTMLAudioElement ||
    target.matches('input, select, textarea') ||
    target.isContentEditable
  );
}

function handleKeydown(event: KeyboardEvent): void {
  if (!open) return;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (ignoresArrowShortcut(event.target)) return;
  if (event.key === 'ArrowLeft') moveSelection(-1);
  else if (event.key === 'ArrowRight') moveSelection(1);
  else return;
  event.preventDefault();
}

function restoreTrigger(event: Event): void {
  const target = triggerElement;
  triggerElement = null;
  if (!target?.isConnected) return;
  event.preventDefault();
  target.focus();
}

$effect(() => {
  if (open && !activeGroup) open = false;
});
</script>

<svelte:window onkeydown={handleKeydown} />

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 bg-black/85 backdrop-blur-sm" style="z-index: 70;" />
    <Dialog.Content
      class="gallery-viewer-content bg-stage text-stage-foreground shadow-[var(--shadow-overlay)]"
      onCloseAutoFocus={restoreTrigger}
    >
      {#if activeGroup}
        <div class="grid size-full min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto]">
          <header class="flex flex-wrap items-center justify-between gap-3 border-b border-stage-border bg-stage-elevated px-3 py-2.5 sm:px-5">
            <div class="min-w-0 flex-1">
              <Dialog.Title class="truncate text-sm font-semibold">{activeGroup.displayName}</Dialog.Title>
              <Dialog.Description class="mt-0.5 truncate text-xs text-stage-muted">
                {activeGroup.provider} · {activeGroup.workflow} · {activeIndex + 1} of {viewableGroups.length}
              </Dialog.Description>
            </div>
            <div class="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                class="focus-ring grid size-9 place-items-center rounded border border-stage-border text-lg disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Previous item"
                disabled={!canGoPrevious}
                onclick={() => moveSelection(-1)}
              >←</button>
              <button
                type="button"
                class="focus-ring grid size-9 place-items-center rounded border border-stage-border text-lg disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Next item"
                disabled={!canGoNext}
                onclick={() => moveSelection(1)}
              >→</button>
              <Dialog.Close class="focus-ring min-h-9 rounded px-3 text-sm font-semibold hover:bg-stage-border">
                Close
              </Dialog.Close>
            </div>
          </header>

          <div
            class="grid min-h-0 place-items-center overflow-hidden p-2 sm:p-4"
            data-testid="gallery-viewer-stage"
          >
            {#key activeGroup.representative.outputId}
              {#if activeGroup.representative.mediaKind === 'image'}
                <img
                  src={activeGroup.representative.mediaUrl}
                  alt={activeGroup.displayName}
                  class="max-h-full max-w-full object-contain"
                  decoding="async"
                />
              {:else}
                <!-- svelte-ignore a11y_media_has_caption -- generated media does not provide a caption track -->
                <video
                  bind:this={activeVideo}
                  src={activeGroup.representative.mediaUrl}
                  aria-label={activeGroup.displayName}
                  class="max-h-full max-w-full object-contain"
                  preload="metadata"
                  controls
                  autoplay={false}
                  playsinline
                ></video>
              {/if}
            {/key}
          </div>

          <footer
            class="gallery-viewer-footer max-h-[42dvh] overflow-y-auto border-t border-stage-border bg-stage-elevated px-3 pt-3 sm:px-5"
            data-testid="gallery-viewer-footer"
          >
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0 flex-1">
                <p class="text-xs font-semibold uppercase tracking-[0.12em] text-stage-muted">
                  {activeGroup.representative.mediaKind} · {activeIndex + 1} of {viewableGroups.length} ·
                  <time datetime={activeGroup.createdAt}>{dateTimeLabel(activeGroup.createdAt)}</time>
                </p>
                <p class="mt-1 line-clamp-2 text-sm leading-5">
                  {activeGroup.promptExcerpt ?? 'No prompt stored'}
                </p>
              </div>
              <nav class="flex flex-wrap gap-2" aria-label="Selected media actions">
                <a class="focus-ring rounded border border-stage-border px-3 py-2 text-xs font-semibold hover:bg-stage-border" href={`/jobs/${activeGroup.jobId}`}>Open job</a>
                <a class="focus-ring rounded border border-stage-border px-3 py-2 text-xs font-semibold hover:bg-stage-border" href={activeGroup.representative.mediaUrl} target="_blank" rel="noreferrer">Open full size</a>
                <a class="focus-ring rounded border border-stage-border px-3 py-2 text-xs font-semibold hover:bg-stage-border" href={`/api/media/${activeGroup.representative.outputId}/download`} download data-sveltekit-reload>Download</a>
              </nav>
            </div>
            <p class="sr-only" role="status" aria-live="polite">
              {activeGroup.representative.mediaKind}, item {activeIndex + 1} of {viewableGroups.length}: {activeGroup.displayName}
            </p>
          </footer>
        </div>
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
