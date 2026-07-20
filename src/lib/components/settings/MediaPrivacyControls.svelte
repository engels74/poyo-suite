<script lang="ts">
import AppIcon from '$lib/components/ui/AppIcon.svelte';
import Badge from '$lib/components/ui/Badge.svelte';
import type {
  MediaPrivacySettings,
  MediaToolReadinessDto,
  MediaToolsReadinessDto
} from '$lib/features/settings/contracts';
import { mediaSanitizationCapabilityState } from '$lib/features/settings/media-privacy';

interface Props {
  mediaPrivacy: MediaPrivacySettings;
  mediaTools: MediaToolsReadinessDto;
  disabled?: boolean;
}

let { mediaPrivacy = $bindable(), mediaTools, disabled = false }: Props = $props();
const componentId = $props.id();

function toolStatusLabel(tool: MediaToolReadinessDto): string {
  if (tool.status === 'ready') return `${tool.detectedVersion ?? tool.minimumVersion} ready`;
  if (tool.status === 'missing') return `${tool.minimumVersion}+ not installed`;
  if (tool.status === 'outdated') {
    return `${tool.detectedVersion ?? 'Older version'} found · ${tool.minimumVersion}+ needed`;
  }
  return 'Could not verify';
}

function toolRepairLabel(tool: MediaToolReadinessDto): string {
  if (tool.status === 'missing') {
    return `Install ${tool.label} ${tool.minimumVersion}+ on the machine running Poyo Local Studio, then restart Studio and reload.`;
  }
  if (tool.status === 'outdated') {
    return `Update ${tool.label} ${tool.detectedVersion ?? 'from the detected older version'} to ${tool.minimumVersion}+ on the machine running Poyo Local Studio, then restart Studio and reload.`;
  }
  return `Studio could not verify ${tool.label}. Resolve the local command issue, then restart Studio and reload.`;
}

let capabilityState = $derived(mediaSanitizationCapabilityState(mediaTools));
let anyReady = $derived(capabilityState !== 'unavailable');
let unavailableTools = $derived(mediaTools.tools.filter((tool) => tool.status !== 'ready'));
let headline = $derived(
  capabilityState === 'unavailable'
    ? 'Optional media cleanup unavailable'
    : !mediaPrivacy.sanitizeLocalMedia
      ? 'Media cleanup off'
      : capabilityState === 'available'
        ? 'Media cleanup available'
        : 'Media cleanup partially available'
);
let capabilitySummary = $derived.by(() => {
  if (capabilityState === 'unavailable') {
    return 'Local uploads still work without cleanup. Install ExifTool 13.55+ with ImageMagick 7.1+ for images; add FFmpeg and ffprobe 8.1+ for videos.';
  }
  if (!mediaPrivacy.sanitizeLocalMedia) {
    return 'Local uploads continue without cleanup. Detected optional capabilities remain visible here.';
  }
  if (capabilityState === 'available') {
    return 'Supported local image and video uploads are cleaned before sharing with Poyo.';
  }
  if (mediaTools.imageReady) {
    return 'Images are cleaned; videos upload without cleanup until their optional tools are available.';
  }
  return 'Videos are cleaned; images upload without cleanup until their optional tools are available.';
});
let preferenceHelp = $derived(
  capabilityState === 'unavailable'
    ? mediaPrivacy.sanitizeLocalMedia
      ? 'The saved cleanup preference is on, but it cannot take effect until a complete optional toolset is available.'
      : 'The saved cleanup preference is off and cannot be changed until a complete optional toolset is available.'
    : 'Applies only to supported local files handled by this app. Remote URLs and existing managed sources are not rewritten.'
);
</script>

<fieldset class="grid gap-3" {disabled}>
  <legend class="text-sm font-semibold">Media privacy</legend>
  <p class="text-xs leading-5 text-muted-foreground">
    Optional cleanup removes selected metadata that can reveal location, device, author, and edit
    history. Color information is preserved by default.
  </p>

  <div
    id={`${componentId}-status`}
    class="rounded px-3 py-2.5 {mediaPrivacy.sanitizeLocalMedia && capabilityState === 'available'
      ? 'bg-success/8'
      : mediaPrivacy.sanitizeLocalMedia && capabilityState === 'partial'
        ? 'bg-warning/8'
        : 'bg-muted/55'}"
    aria-live="polite"
  >
    <div class="flex items-start gap-2.5">
      <AppIcon
        name="shield"
        size={17}
        class={mediaPrivacy.sanitizeLocalMedia && capabilityState === 'available'
          ? 'mt-0.5 text-success'
          : 'mt-0.5 text-muted-foreground'}
      />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-semibold">{headline}</p>
        <div class="mt-2 flex flex-wrap gap-2">
          <Badge tone={mediaTools.imageReady ? 'success' : 'warning'}>
            Image · {mediaTools.imageReady ? 'Available' : 'Unavailable'}
          </Badge>
          <Badge tone={mediaTools.videoReady ? 'success' : 'warning'}>
            Video · {mediaTools.videoReady ? 'Available' : 'Unavailable'}
          </Badge>
        </div>
        <p class="mt-2 text-xs leading-5 text-foreground">{capabilitySummary}</p>
      </div>
    </div>

    <details class="mt-2 border-t border-border/70 pt-2 text-xs">
      <summary class="focus-ring w-fit cursor-pointer rounded font-semibold">Tool details</summary>
      <ul class="mt-2 grid list-none gap-2 p-0">
        {#each mediaTools.tools as tool (tool.name)}
          <li class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span class="font-semibold">{tool.label}</span>
            <span class="tabular-nums text-muted-foreground">{toolStatusLabel(tool)}</span>
          </li>
        {/each}
      </ul>
      {#if unavailableTools.length}
        <ul class="mt-3 grid list-none gap-2 border-t border-border/70 pt-3 p-0">
          {#each unavailableTools as tool (tool.name)}
            <li class="leading-5 text-foreground">{toolRepairLabel(tool)}</li>
          {/each}
        </ul>
      {/if}
    </details>
  </div>

  <label class="focus-within:ring-2 focus-within:ring-ring flex items-start gap-3 rounded p-1 text-sm">
    <input
      type="checkbox"
      bind:checked={mediaPrivacy.sanitizeLocalMedia}
      disabled={disabled || !anyReady}
      aria-describedby={`${componentId}-status ${componentId}-preference-help`}
      class="focus-ring mt-0.5 size-4"
    />
    <span>
      <strong>Sanitize supported local media when available</strong>
      <span
        id={`${componentId}-preference-help`}
        class="mt-1 block text-xs leading-5 text-muted-foreground"
      >
        {preferenceHelp}
      </span>
    </span>
  </label>

  <div class="ml-4 grid gap-2 border-l border-border pl-4">
    <label class="focus-within:ring-2 focus-within:ring-ring flex items-center gap-3 rounded p-1 text-sm">
      <input
        type="checkbox"
        bind:checked={mediaPrivacy.removeExif}
        disabled={disabled || !anyReady || !mediaPrivacy.sanitizeLocalMedia}
        aria-describedby={`${componentId}-status`}
        class="focus-ring size-4"
      />
      Remove EXIF metadata
    </label>
    <label class="focus-within:ring-2 focus-within:ring-ring flex items-center gap-3 rounded p-1 text-sm">
      <input
        type="checkbox"
        bind:checked={mediaPrivacy.removeIptc}
        disabled={disabled || !anyReady || !mediaPrivacy.sanitizeLocalMedia}
        aria-describedby={`${componentId}-status`}
        class="focus-ring size-4"
      />
      Remove IPTC metadata
    </label>
    <label class="focus-within:ring-2 focus-within:ring-ring flex items-center gap-3 rounded p-1 text-sm">
      <input
        type="checkbox"
        bind:checked={mediaPrivacy.removeXmp}
        disabled={disabled || !anyReady || !mediaPrivacy.sanitizeLocalMedia}
        aria-describedby={`${componentId}-status`}
        class="focus-ring size-4"
      />
      Remove XMP metadata
    </label>
    <label class="focus-within:ring-2 focus-within:ring-ring flex items-center gap-3 rounded p-1 text-sm">
      <input
        type="checkbox"
        bind:checked={mediaPrivacy.removePhotoshop8bim}
        disabled={disabled || !anyReady || !mediaPrivacy.sanitizeLocalMedia}
        aria-describedby={`${componentId}-status`}
        class="focus-ring size-4"
      />
      Remove Photoshop/8BIM metadata
    </label>
    <label class="focus-within:ring-2 focus-within:ring-ring flex items-center gap-3 rounded p-1 text-sm">
      <input
        type="checkbox"
        bind:checked={mediaPrivacy.removeColorProfile}
        disabled={disabled || !anyReady || !mediaPrivacy.sanitizeLocalMedia}
        aria-describedby={`${componentId}-status`}
        class="focus-ring size-4"
      />
      Remove color profile
    </label>
  </div>

  <p class="border-t border-border pt-3 text-xs leading-5 text-muted-foreground">
    Metadata cleanup does not anonymize visible people, places, text, or audio, and cannot remove
    identifying details embedded in the media itself.
  </p>
</fieldset>
