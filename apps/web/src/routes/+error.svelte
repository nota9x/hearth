<script lang="ts">
  import { instanceName } from '@hearth/core/branding-view';

  import { page } from '$app/state';
  import HttpError from '$lib/HttpError.svelte';
</script>

<svelte:head
  ><title>{page.status} · {instanceName(page.data.siteName)}</title
  ></svelte:head
>
<HttpError
  status={page.status}
  name={page.data.siteName}
  origin={page.data.appOrigin}
/>
