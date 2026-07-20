<script lang="ts">
import { Dialog } from 'bits-ui';
import { onMount } from 'svelte';
import AppIcon from '$lib/components/ui/AppIcon.svelte';

interface Props {
  mediaKind: 'image' | 'video';
  src: string | null;
  alt: string;
  class?: string;
  controls?: boolean;
  viewable?: boolean;
  preload?: 'none' | 'metadata' | 'auto';
  /** `cover` fills the frame (may crop); `contain` preserves the full asset with letterboxing. */
  fit?: 'cover' | 'contain';
}

let {
  mediaKind,
  src,
  alt,
  class: className = '',
  controls = false,
  viewable = false,
  preload = 'metadata',
  fit = 'cover'
}: Props = $props();

let fitClass = $derived(fit === 'contain' ? 'object-contain' : 'object-cover');
let open = $state(false);
let zoom = $state(1);
let fullscreen = $state(false);
let fullscreenAvailable = $state(false);
let viewer = $state<HTMLElement | null>(null);

let zoomPercent = $derived(Math.round(zoom * 100));

onMount(() => {
  fullscreenAvailable = document.fullscreenEnabled;
});

function changeZoom(delta: number): void {
  zoom = Math.max(0.5, Math.min(4, Number((zoom + delta).toFixed(2))));
}

async function toggleFullscreen(): Promise<void> {
  if (!viewer || !document.fullscreenEnabled) return;
  if (document.fullscreenElement) await document.exitFullscreen();
  else await viewer.requestFullscreen();
}

$effect(() => {
  if (!open) zoom = 1;
});

$effect(() => {
  if (!open) return;
  const update = (): void => {
    fullscreen = document.fullscreenElement === viewer;
  };
  document.addEventListener('fullscreenchange', update);
  return () => document.removeEventListener('fullscreenchange', update);
});
</script>

<div class={`relative overflow-hidden bg-stage text-stage-foreground ${className}`}>
  {#if src && mediaKind === 'image'}
    <img class={`size-full ${fitClass}`} {src} {alt} loading="lazy" decoding="async" />
  {:else if src && mediaKind === 'video'}
    <!-- svelte-ignore a11y_media_has_caption -- generated media does not provide a caption track -->
    <video
      class={`size-full ${fitClass}`}
      {src}
      aria-label={alt}
      {preload}
      {controls}
      playsinline
    ></video>
  {:else}
    <div class="grid size-full min-h-28 place-items-center px-4 text-center text-stage-muted">
      <div>
        <AppIcon name={mediaKind} size={24} class="mx-auto" />
        <p class="mt-2 text-xs font-semibold">Local preview unavailable</p>
      </div>
    </div>
  {/if}

  {#if src && viewable}
    <div class="absolute top-2 right-2 flex items-center gap-1.5">
      <Dialog.Root bind:open>
        <Dialog.Trigger
          class="focus-ring inline-flex min-h-8 items-center rounded bg-background/90 px-2.5 text-xs font-semibold text-foreground shadow-[var(--shadow-sm)] backdrop-blur hover:bg-background"
          aria-label={`Open full-screen media viewer for ${alt}`}
        >
          View
        </Dialog.Trigger>
        <Dialog.Portal>
        <Dialog.Overlay class="fixed inset-0 z-50 bg-black/85" />
        <Dialog.Content
          class="fixed inset-0 z-50 bg-stage text-stage-foreground"
          onkeydown={(event) => {
            if (mediaKind !== 'image') return;
            if (event.key === '+' || event.key === '=') changeZoom(0.25);
            else if (event.key === '-') changeZoom(-0.25);
            else if (event.key === '0') zoom = 1;
            else return;
            event.preventDefault();
          }}
        >
          <div bind:this={viewer} class="grid size-full grid-rows-[auto_minmax(0,1fr)_auto] bg-stage text-stage-foreground">
            <header class="flex items-center justify-between gap-3 border-b border-stage-border bg-stage-elevated px-3 py-2 sm:px-5">
            <div class="min-w-0">
              <Dialog.Title class="truncate text-sm font-semibold">{alt}</Dialog.Title>
              <Dialog.Description class="mt-0.5 text-xs text-stage-muted">
                {mediaKind === 'image'
                  ? 'Zoom with the controls or plus, minus and zero keys.'
                  : 'Generated video with browser playback controls.'}
              </Dialog.Description>
            </div>
            <Dialog.Close class="focus-ring min-h-9 rounded px-3 text-sm font-semibold hover:bg-stage-border">
              Close
            </Dialog.Close>
            </header>

            <div class="grid min-h-0 place-items-center overflow-auto p-4 sm:p-6">
              {#if mediaKind === 'image'}
                <img
                  {src}
                  {alt}
                  class="max-h-full max-w-full object-contain"
                  style={`transform: scale(${zoom}); transform-origin: center;`}
                />
              {:else}
                <!-- svelte-ignore a11y_media_has_caption -- generated media does not provide a caption track -->
                <video
                  {src}
                  aria-label={alt}
                  class="max-h-full max-w-full object-contain"
                  preload="metadata"
                  controls
                  autoplay={false}
                  playsinline
                ></video>
              {/if}
            </div>

            <footer class="flex min-h-12 flex-wrap items-center justify-center gap-2 border-t border-stage-border bg-stage-elevated px-3 py-2">
            {#if mediaKind === 'image'}
              <button
                type="button"
                class="focus-ring min-h-8 rounded border border-stage-border px-3 text-xs font-semibold disabled:opacity-50"
                aria-label="Zoom out"
                disabled={zoom <= 0.5}
                onclick={() => changeZoom(-0.25)}
              >−</button>
              <button
                type="button"
                class="focus-ring min-h-8 min-w-20 rounded border border-stage-border px-3 text-xs font-semibold"
                onclick={() => (zoom = 1)}
              >{zoomPercent}%</button>
              <button
                type="button"
                class="focus-ring min-h-8 rounded border border-stage-border px-3 text-xs font-semibold disabled:opacity-50"
                aria-label="Zoom in"
                disabled={zoom >= 4}
                onclick={() => changeZoom(0.25)}
              >+</button>
            {/if}
            {#if fullscreenAvailable}
              <button
                type="button"
                class="focus-ring min-h-8 rounded border border-stage-border px-3 text-xs font-semibold"
                onclick={() => void toggleFullscreen()}
              >{fullscreen ? 'Exit browser full screen' : 'Enter browser full screen'}</button>
            {/if}
            <p class="sr-only" role="status" aria-live="polite">
              {mediaKind === 'image' ? `Zoom ${zoomPercent} percent.` : ''}
              {fullscreen ? ' Browser full screen active.' : ''}
            </p>
            </footer>
          </div>
        </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {#if mediaKind === 'image'}
        <a href={src} target="_blank" rel="noreferrer" class="focus-ring grid size-8 shrink-0 place-items-center rounded bg-background/90 text-base leading-none text-foreground shadow-[var(--shadow-sm)] backdrop-blur hover:bg-background" aria-label={`Open ${alt} in a new tab`} title="Open image in a new tab"><span aria-hidden="true">↗</span></a>
      {/if}
    </div>
  {/if}
</div>
