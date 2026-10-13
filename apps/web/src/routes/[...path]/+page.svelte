<script lang="ts">
  import Dashboard from '$lib/Dashboard.svelte';

  import type { PageProps as PageProperties } from './$types';

  const { data }: PageProperties = $props();
</script>

<Dashboard {data} />
