<script lang="ts">
  import ListChecks from '@lucide/svelte/icons/list-checks';
  import X from '@lucide/svelte/icons/x';
  import type { Snippet } from 'svelte';

  import { fadeMotion } from '#lib/motion.ts';

  const {
    count,
    noun,
    selectAll,
    clear,
    disabled = false,
    children,
  }: {
    count: number;
    noun: string;
    selectAll: () => Promise<void>;
    clear: () => void;
    disabled?: boolean;
    children: Snippet;
  } = $props();
</script>

{#if count}<div class="motion-frame">
    <div
      class="bulk-bar"
      transition:fadeMotion={{ kind: 'content' }}
      role="group"
      aria-label={`Selected ${noun} actions`}
    >
      <span>{count} selected</span>
      <button type="button" {disabled} onclick={selectAll}
        ><ListChecks size={16} />Select all</button
      >
      {@render children()}
      <button {disabled} onclick={clear}><X size={16} />Clear</button>
    </div>
  </div>{/if}
