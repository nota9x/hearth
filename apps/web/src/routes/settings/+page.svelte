<script lang="ts">
  import UserSettings from '$lib/settings/UserSettings.svelte';

  import type { PageProps as PageProperties } from './$types';

  const { data }: PageProperties = $props();
</script>

<svelte:head><title>Settings · {data.siteName}</title></svelte:head>
<UserSettings {data} />
