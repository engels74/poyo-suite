<script lang="ts">
import JobDetailView from '$lib/components/library/JobDetailView.svelte';
import type { PageData } from './$types';
let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>{data.job.displayName} · Library · Poyo Local Studio</title></svelte:head>
<JobDetailView job={data.job} context="library" mediaCapabilities={data.mediaCapabilities} />
