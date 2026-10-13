<script lang="ts">
  import type { Snippet } from 'svelte';

  const {
    title,
    description,
    children,
  }: { title: string; description?: string; children: Snippet } = $props();
  const id = $props.id();
</script>

<section class="settings-section" aria-labelledby={id}>
  <header class="settings-section-heading">
    <h2 {id}>{title}</h2>
    {#if description}<p>{description}</p>{/if}
  </header>
  {@render children()}
</section>
