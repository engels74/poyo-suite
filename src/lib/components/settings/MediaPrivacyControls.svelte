<script lang="ts">
import AppIcon from '$lib/components/ui/AppIcon.svelte';
import Badge from '$lib/components/ui/Badge.svelte';
import type {
  MediaPrivacySettings,
  MediaToolReadinessDto,
  MediaToolsReadinessDto
} from '$lib/features/settings/contracts';

interface Props {
  mediaPrivacy: MediaPrivacySettings;
  mediaTools: MediaToolsReadinessDto;
  disabled?: boolean;
}

let { mediaPrivacy = $bindable(), mediaTools, disabled = false }: Props = $props();

function toolStatusLabel(tool: MediaToolReadinessDto): string {
  if (tool.status === 'ready') return `${tool.detectedVersion ?? tool.minimumVersion} ready`;
  if (tool.status === 'missing') return `${tool.minimumVersion}+ needed`;
  if (tool.status === 'outdated') {
    return `${tool.detectedVersion ?? 'Older version'} found · ${tool.minimumVersion}+ needed`;
  }
  return 'Could not verify';
}

function toolRepairLabel(tool: MediaToolReadinessDto): string {
  if (tool.status === 'missing') {
    return `${tool.label} is not available to the Studio server. Install ${tool.minimumVersion} or newer on the machine running Poyo Local Studio, then restart Studio and reload.`;
  }
  if (tool.status === 'outdated') {
    return `${tool.label} ${tool.detectedVersion ?? 'an older version'} is available; ${tool.minimumVersion} or newer is required. Update it on the machine running Poyo Local Studio, then restart Studio and reload.`;
  }
  return `Studio could not verify ${tool.label}. Restart Studio and reload after resolving the local command error.`;
}

let allReady = $derived(mediaTools.imageReady && mediaTools.videoReady);
let unavailableTools = $derived(mediaTools.tools.filter((tool) => tool.status !== 'ready'));
</script>

<fieldset class="grid gap-3" {disabled}>
  <legend class="text-sm font-semibold">Media privacy</legend>
  <p class="text-xs leading-5 text-muted-foreground">
    Recommended protection removes metadata that can reveal location, device, author, and edit
    history. Color information is preserved by default.
  </p>

  <div
    class="rounded border px-3 py-3 {mediaPrivacy.sanitizeLocalMedia
      ? allReady
        ? 'border-success/30 bg-success/10'
        : 'border-warning/30 bg-warning/10'
      : 'border-border bg-muted/50'}"
  >
    <div class="flex items-start gap-2.5">
      <AppIcon
        name="shield"
        size={17}
        class={mediaPrivacy.sanitizeLocalMedia && allReady
          ? 'mt-0.5 text-success'
          : 'mt-0.5 text-muted-foreground'}
      />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-semibold">
          {mediaPrivacy.sanitizeLocalMedia
            ? allReady
              ? 'Media protection ready'
              : 'Media protection needs setup'
            : 'Media protection is off'}
        </p>
        <p class="mt-1 text-xs leading-5 text-foreground">
          {mediaPrivacy.sanitizeLocalMedia
            ? allReady
              ? 'Ready to clean metadata from image and video uploads.'
              : 'Only affected local uploads stay unavailable until their tools are ready.'
            : 'Local files will be uploaded without metadata cleanup.'}
        </p>
        <div class="mt-2 flex flex-wrap gap-2">
          <Badge
            tone={mediaPrivacy.sanitizeLocalMedia
              ? mediaTools.imageReady
                ? 'success'
                : 'warning'
              : 'neutral'}
          >
            Image · {mediaPrivacy.sanitizeLocalMedia
              ? mediaTools.imageReady
                ? 'Ready'
                : 'Needs setup'
              : 'No cleanup'}
          </Badge>
          <Badge
            tone={mediaPrivacy.sanitizeLocalMedia
              ? mediaTools.videoReady
                ? 'success'
                : 'warning'
              : 'neutral'}
          >
            Video · {mediaPrivacy.sanitizeLocalMedia
              ? mediaTools.videoReady
                ? 'Ready'
                : 'Needs setup'
              : 'No cleanup'}
          </Badge>
        </div>
      </div>
    </div>

    <details class="mt-3 border-t border-border/70 pt-2 text-xs">
      <summary class="focus-ring w-fit cursor-pointer rounded font-semibold">Tool details</summary>
      <ul class="mt-2 grid list-none gap-2 p-0">
        {#each mediaTools.tools as tool (tool.name)}
          <li class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span class="font-semibold">{tool.label}</span>
            <span class="tabular-nums text-muted-foreground">{toolStatusLabel(tool)}</span>
          </li>
        {/each}
      </ul>
      {#if mediaPrivacy.sanitizeLocalMedia && unavailableTools.length}
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
      class="focus-ring mt-0.5 size-4"
    />
    <span>
      <strong>Sanitize local media before sharing with Poyo</strong>
      <span class="mt-1 block text-xs leading-5 text-muted-foreground">
        Applies to local files handled by this app. Remote URLs and existing managed sources are not
        rewritten.
      </span>
    </span>
  </label>

  <div class="ml-4 grid gap-2 border-l border-border pl-4">
    <label class="focus-within:ring-2 focus-within:ring-ring flex items-center gap-3 rounded p-1 text-sm">
      <input type="checkbox" bind:checked={mediaPrivacy.removeExif} disabled={!mediaPrivacy.sanitizeLocalMedia} class="focus-ring size-4" />
      Remove EXIF metadata
    </label>
    <label class="focus-within:ring-2 focus-within:ring-ring flex items-center gap-3 rounded p-1 text-sm">
      <input type="checkbox" bind:checked={mediaPrivacy.removeIptc} disabled={!mediaPrivacy.sanitizeLocalMedia} class="focus-ring size-4" />
      Remove IPTC metadata
    </label>
    <label class="focus-within:ring-2 focus-within:ring-ring flex items-center gap-3 rounded p-1 text-sm">
      <input type="checkbox" bind:checked={mediaPrivacy.removeXmp} disabled={!mediaPrivacy.sanitizeLocalMedia} class="focus-ring size-4" />
      Remove XMP metadata
    </label>
    <label class="focus-within:ring-2 focus-within:ring-ring flex items-center gap-3 rounded p-1 text-sm">
      <input type="checkbox" bind:checked={mediaPrivacy.removePhotoshop8bim} disabled={!mediaPrivacy.sanitizeLocalMedia} class="focus-ring size-4" />
      Remove Photoshop/8BIM metadata
    </label>
    <label class="focus-within:ring-2 focus-within:ring-ring flex items-center gap-3 rounded p-1 text-sm">
      <input type="checkbox" bind:checked={mediaPrivacy.removeColorProfile} disabled={!mediaPrivacy.sanitizeLocalMedia} class="focus-ring size-4" />
      Remove color profile
    </label>
  </div>

  <p class="rounded border border-border bg-muted/50 px-3 py-2 text-xs leading-5 text-muted-foreground">
    Metadata removal does not anonymize visible people, places, text, or audio, and cannot remove
    identifying details embedded in the media itself.
  </p>
</fieldset>
