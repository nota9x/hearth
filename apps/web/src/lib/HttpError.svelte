<script lang="ts">
  import { httpErrorStyles, renderHttpError } from '@hearth/core/http-error';

  const {
    status,
    name = '',
    origin = '',
  }: { status: number; name?: string; origin?: string } = $props();
  const markup = $derived(
    `<style>${httpErrorStyles}</style>${renderHttpError(status, 'page', name, origin)}`,
  );
</script>

<!-- Only the shared renderer's escaped, controlled output is accepted here. -->
<!-- eslint-disable-next-line svelte/no-at-html-tags -->
{@html markup}
