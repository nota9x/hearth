<script lang="ts">
  import { instanceName } from '@hearth/core/branding-view';

  import HttpError from '#lib/HttpError.svelte';
  import { page } from '$app/state';
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
