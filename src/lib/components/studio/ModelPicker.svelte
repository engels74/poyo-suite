<script lang="ts">
import { tick } from 'svelte';
import Badge from '$lib/components/ui/Badge.svelte';
import type { StudioEntry } from '$lib/features/generation/contracts';
import { groupStudioEntries, studioProviderLabel } from '$lib/features/generation/model-groups';
import { workflowLabel } from '$lib/features/generation/studio-controller';

interface Props {
  entries: StudioEntry[];
  selectedKey: string;
  favorites: string[];
  onchange: (entry: StudioEntry) => void;
}

let { entries, selectedKey, favorites, onchange }: Props = $props();
let query = $state('');
let disclosureOpen = $state(false);
let summary = $state<HTMLElement | null>(null);
let id = $props.id();
let selectedEntry = $derived(entries.find((entry) => entry.key === selectedKey));
let groups = $derived(groupStudioEntries(entries, favorites, query));
let filteredCount = $derived(groups.reduce((count, group) => count + group.entries.length, 0));

function selectEntry(entry: StudioEntry): void {
  onchange(entry);
  disclosureOpen = false;
  void tick().then(() => summary?.focus());
}
</script>

<fieldset class="grid gap-2">
  <legend class="text-xs font-semibold">Audited model</legend>
  <details
    class="rounded-[var(--radius)] border border-border bg-background"
    bind:open={disclosureOpen}
  >
    <summary
      bind:this={summary}
      class="focus-ring cursor-pointer list-none rounded-[var(--radius)] px-3 py-2.5 marker:hidden"
    >
      {#if selectedEntry}
        <span class="flex min-w-0 items-center justify-between gap-3">
          <span class="min-w-0">
            <span class="block truncate text-sm font-semibold">{selectedEntry.displayName}</span>
            <span class="mt-0.5 block truncate text-[0.6875rem] text-muted-foreground">
              {studioProviderLabel(selectedEntry)} · {selectedEntry.publicModelId}
            </span>
          </span>
          <span class="shrink-0 text-xs font-semibold text-primary">
            {disclosureOpen ? 'Close' : 'Change'}
          </span>
        </span>
      {:else}
        <span class="flex items-center justify-between gap-3 text-sm font-semibold">
          Choose an audited model
          <span class="text-xs text-primary">{disclosureOpen ? 'Close' : 'Choose'}</span>
        </span>
      {/if}
    </summary>

    <div class="grid gap-3 border-t border-border px-3 py-3">
      <label class="sr-only" for={`${id}-search`}>Search audited models</label>
      <input
        id={`${id}-search`}
        type="search"
        class="focus-ring h-9 w-full rounded-[var(--radius)] border border-input bg-background px-3 text-sm"
        placeholder="Search models or providers"
        bind:value={query}
      />
      <p class="sr-only" aria-live="polite">
        {filteredCount} audited {filteredCount === 1 ? 'model' : 'models'} available.
      </p>
      <div class="grid max-h-72 gap-4 overflow-y-auto pr-1">
        {#each groups as group, groupIndex (group.key)}
          <section aria-labelledby={`${id}-provider-${groupIndex}`}>
            <h3
              id={`${id}-provider-${groupIndex}`}
              class="mb-1.5 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground"
            >
              {group.provider}
            </h3>
            <div class="grid gap-1.5">
              {#each group.entries as entry (entry.key)}
                <label
                  class="focus-within:ring-2 focus-within:ring-ring cursor-pointer rounded-[var(--radius)] border bg-background px-3 py-2.5"
                  class:border-primary={entry.key === selectedKey}
                  class:border-border={entry.key !== selectedKey}
                >
                  <input
                    class="sr-only"
                    type="radio"
                    name={`${id}-model`}
                    value={entry.key}
                    checked={entry.key === selectedKey}
                    onchange={() => selectEntry(entry)}
                  />
                  <span class="flex items-start justify-between gap-2">
                    <span class="min-w-0">
                      <span class="block truncate text-sm font-semibold">
                        {favorites.includes(entry.key) ? '★ ' : ''}{entry.displayName}
                      </span>
                      <span class="mt-0.5 block truncate text-[0.6875rem] text-muted-foreground">
                        {studioProviderLabel(entry)} · {entry.publicModelId}
                      </span>
                    </span>
                    <Badge tone={entry.status === 'current' ? 'success' : 'neutral'}>{entry.status}</Badge>
                  </span>
                  <span class="mt-2 flex flex-wrap gap-1 text-[0.6875rem] text-muted-foreground">
                    <span>{workflowLabel(entry.workflow)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{entry.inputRoles.length ? `${entry.inputRoles.length} media role${entry.inputRoles.length === 1 ? '' : 's'}` : 'Prompt only'}</span>
                  </span>
                </label>
              {/each}
            </div>
          </section>
        {:else}
          <p class="rounded-[var(--radius)] bg-muted px-3 py-4 text-sm text-muted-foreground">
            No audited model matches “{query}”.
          </p>
        {/each}
      </div>
    </div>
  </details>
</fieldset>
