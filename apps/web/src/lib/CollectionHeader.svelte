<script lang="ts">
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import type { Snippet } from 'svelte';

  import { fadeMotion } from '#lib/motion.ts';
  import { navigating } from '$app/state';

  import { dashboard } from './dashboard';
  import Spinner from './Spinner.svelte';

  const {
    title,
    refresh,
    busy = false,
    subtitle,
    children,
  }: {
    title: string;
    refresh: () => Promise<void>;
    busy?: boolean;
    subtitle?: Snippet;
    children?: Snippet;
  } = $props();
</script>

<div class="page-top">
  <div class="page-title">
    <h1>{title}</h1>
    {@render subtitle?.()}
  </div>
  <div class="page-actions">
    <button
      onclick={refresh}
      disabled={$dashboard || busy || !!navigating.to}
      aria-busy={$dashboard}
    >
      <span class="feedback-icon"
        >{#key $dashboard}<span transition:fadeMotion
            >{#if $dashboard}<Spinner size={17} />{:else}<RefreshCw
                size={17}
              />{/if}</span
          >{/key}</span
      >
      {$dashboard ? 'Refreshing…' : 'Refresh'}
    </button>
    {@render children?.()}
  </div>
</div>

<style>
  .page-title {
    min-width: 0;
  }
</style>
