<script lang="ts">
  import AdminSettings from '#lib/AdminSettings.svelte';
  import AdminTabs from '#lib/AdminTabs.svelte';
  import SettingsPage from '#lib/settings/SettingsPage.svelte';

  import type { PageProps as PageProperties } from './$types';

  const { data: initialData }: PageProperties = $props();
  let data = $derived(initialData);
</script>

<svelte:head><title>Admin · Settings · {data.siteName}</title></svelte:head>
<AdminTabs section="settings" />
<SettingsPage admin bind:data>
  <AdminSettings {data} />
</SettingsPage>
