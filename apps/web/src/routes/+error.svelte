<script lang="ts">
  import { instanceName } from '@hearth/core/branding-view';

  import HttpError from '#lib/HttpError.svelte';
  import { page } from '$app/state';

  import type { ErrorProps as ErrorProperties } from './$types';

  const { error }: ErrorProperties = $props();
</script>

<svelte:head
  ><title>{error.status} · {instanceName(page.data.siteName)}</title
  ></svelte:head
>
<HttpError
  status={error.status}
  name={page.data.siteName}
  origin={page.data.appOrigin}
/>
