<script lang="ts">
  import type { LucideIcon } from '@lucide/svelte';

  const {
    items,
    label = 'Statistics',
  }: {
    items: {
      label: string;
      value: string | number;
      icon: LucideIcon;
    }[];
    label?: string;
  } = $props();
</script>

{#if items.length > 0}
  <div class="statistics-panel">
    <dl class="statistics" aria-label={label}>
      {#each items as item (item.label)}
        <div class="stat">
          <dt><item.icon size={15} aria-hidden="true" />{item.label}</dt>
          <dd><span class="stat-value">{item.value}</span></dd>
        </div>
      {/each}
    </dl>
  </div>
{/if}

<style>
  .statistics-panel {
    container-type: inline-size;
    margin-bottom: 2rem;
  }
  .statistics {
    display: flex;
    flex-wrap: wrap;
    margin: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: linear-gradient(115deg, #252019, #1c1916);
    overflow: hidden;
  }
  .stat {
    flex: 1 1 12rem;
    min-width: 0;
    padding: 24px 25px;
    box-shadow:
      -1px 0 0 var(--border),
      0 -1px 0 var(--border);
  }
  dt {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
    font-size: 0.73rem;
  }
  dt :global(svg) {
    flex-shrink: 0;
  }
  dd {
    margin: 9px 0 0;
    overflow-wrap: anywhere;
  }
  .stat-value {
    display: block;
    font-size: 2rem;
    letter-spacing: -0.05em;
    font-weight: 500;
    line-height: 1.3;
  }
  @container (max-width: 720px) {
    .stat {
      flex-basis: 50%;
      padding: 20px;
    }
  }
  @container (max-width: 360px) {
    .stat {
      flex-basis: 100%;
    }
  }
</style>
