<script lang="ts">
  import { renderBrand } from '@hearth/core/branding-view';

  const { name, href }: { name: string; href: string } = $props();
  const markup = $derived(renderBrand(name));
</script>

<a {href} class="brand">
  <!-- The shared renderer escapes the instance name. -->
  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
  {@html markup}
</a>
