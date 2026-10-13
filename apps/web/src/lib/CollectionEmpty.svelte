<script lang="ts">
  import type { Snippet } from 'svelte';

  import { fadeMotion } from '#lib/motion.ts';
  import { afterNavigate, beforeNavigate } from '$app/navigation';

  let leavingRoute = false;
  beforeNavigate(({ from, to }) => {
    leavingRoute = from?.url.pathname !== to?.url.pathname;
  });
  afterNavigate(() => (leavingRoute = false));
  function transition(node: HTMLElement) {
    const config = fadeMotion(node, { kind: 'content' });
    return (options: { direction?: 'in' | 'out' } = {}) => ({
      ...config(options),
      ...(leavingRoute && { duration: 0 }),
    });
  }

  const {
    title,
    message,
    icon,
    children,
  }: { title: string; message: string; icon: Snippet; children?: Snippet } =
    $props();
</script>

<div class="motion-frame">
  <div class="empty" transition:transition|global>
    {@render icon()}
    <h2>{title}</h2>
    <p>{message}</p>
    <div class="empty-search-actions">{@render children?.()}</div>
  </div>
</div>
