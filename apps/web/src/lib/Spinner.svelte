<script lang="ts">
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';

  const {
    size = 18,
    class: className = '',
  }: { size?: number; class?: string } = $props();
</script>

<LoaderCircle
  {size}
  aria-hidden="true"
  class={`loading-spinner ${className}`}
/>

<style>
  :global(.loading-spinner) {
    flex-shrink: 0;
    mask-image: conic-gradient(
      from 90deg,
      #0000,
      #000 270deg,
      #000 320deg,
      #0000 350deg
    );
    animation: spinner-turn 1100ms linear infinite;
  }
  @keyframes spinner-turn {
    to {
      transform: rotate(360deg);
    }
  }
</style>
