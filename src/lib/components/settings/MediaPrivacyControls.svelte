<script lang="ts">
import type { MediaPrivacySettings } from '$lib/features/settings/contracts';

interface Props {
  mediaPrivacy: MediaPrivacySettings;
  disabled?: boolean;
}

let { mediaPrivacy = $bindable(), disabled = false }: Props = $props();
</script>

<fieldset class="grid gap-3" {disabled}>
  <legend class="text-sm font-semibold">Media privacy</legend>
  <p class="text-xs leading-5 text-muted-foreground">
    Recommended protection removes metadata that can reveal location, device, author, and edit
    history. Color information is preserved by default.
  </p>

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
