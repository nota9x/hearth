<script lang="ts">
  import Sections from '$lib/AdminSections.svelte';
  import Tabs from '$lib/AdminTabs.svelte';
  import Dashboard from '$lib/Dashboard.svelte';
  import Domains from '$lib/DomainManagement.svelte';

  import type { PageProps as PageProperties } from './$types';

  const { data }: PageProperties = $props();
  const adminComponents = { Sections, Tabs, Domains };
</script>

<Dashboard {data} {adminComponents} />
