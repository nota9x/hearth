<script lang="ts">
  import Ban from '@lucide/svelte/icons/ban';
  import Check from '@lucide/svelte/icons/check';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import Clock3 from '@lucide/svelte/icons/clock-3';
  import Download from '@lucide/svelte/icons/download';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import X from '@lucide/svelte/icons/x';

  import { fadeMotion } from '#lib/motion.ts';

  import type { NotificationItem } from './notifications';
  import Spinner from './Spinner.svelte';

  const {
    items,
    label = 'Operation items',
    visible = true,
    onCancel,
  }: {
    items: NotificationItem[];
    label?: string;
    visible?: boolean;
    onCancel: (itemId: string) => void;
  } = $props();
  let page = $state(0);
  const pageSize = 20;
  const itemPriority = (item: NotificationItem) =>
    item.state === 'failed' ? 0 : item.warning ? 1 : 2;
  const orderedItems = $derived(
    items.toSorted((a, b) => itemPriority(a) - itemPriority(b)),
  );
  const lastPage = $derived(
    Math.max(0, Math.ceil(items.length / pageSize) - 1),
  );
  const currentPage = $derived(Math.min(page, lastPage));
  const icons = {
    pending: Clock3,
    active: Spinner,
    saving: Spinner,
    completed: Check,
    failed: CircleAlert,
    cancelled: Ban,
    started: Download,
  };
</script>

{#snippet row(item: NotificationItem)}
  {@const Icon = icons[item.state]}
  <div class="item-row" data-state={item.state}>
    <span class="item-icon">
      {#key Icon}<span transition:fadeMotion={{ enabled: visible }}
          ><Icon size={14} aria-hidden="true" /></span
        >{/key}
    </span>
    <div class="item-copy">
      <strong title={item.name}>{item.name}</strong>
      <p class="item-meta">
        {item.status}{item.metadata ? ` · ${item.metadata}` : ''}
      </p>
      {#if item.error}<p
          in:fadeMotion={{ kind: 'content', enabled: visible }}
          class="item-error"
        >
          {item.error}
        </p>{/if}
      {#if item.warning}<p
          in:fadeMotion={{ kind: 'content', enabled: visible }}
          class="item-warning"
        >
          {item.warning} The image is saved; create a link from Images when delivery
          is available.
        </p>{/if}
    </div>
    {#if item.action}
      {@const ActionIcon = item.action.kind === 'retry' ? RotateCcw : X}
      <button
        type="button"
        class="icon-button compact row-action"
        class:quiet={item.action.kind === 'cancel'}
        aria-label={item.action.label}
        title={item.action.label}
        onclick={() =>
          item.action?.kind === 'cancel'
            ? onCancel(item.id)
            : item.action?.run()}
      >
        <ActionIcon size={14} aria-hidden="true" />
      </button>
    {/if}
  </div>
{/snippet}

<div class="notification-items" class:single={items.length === 1}>
  {#if items.length === 1}
    {@render row(items[0])}
  {:else}
    <ul aria-label={label}>
      {#each orderedItems.slice(currentPage * pageSize, (currentPage + 1) * pageSize) as item (item.id)}
        <li>{@render row(item)}</li>
      {/each}
    </ul>
    {#if items.length > pageSize}
      <nav aria-label={`${label} pages`}>
        <button
          type="button"
          class="icon-button compact"
          aria-label="Previous items"
          disabled={currentPage === 0}
          onclick={() => (page = currentPage - 1)}
          ><ChevronLeft size={14} aria-hidden="true" /></button
        >
        <span>Page {currentPage + 1} of {lastPage + 1}</span>
        <button
          type="button"
          class="icon-button compact"
          aria-label="Next items"
          disabled={currentPage === lastPage}
          onclick={() => (page = currentPage + 1)}
          ><ChevronRight size={14} aria-hidden="true" /></button
        >
      </nav>
    {/if}
  {/if}
</div>

<style>
  .notification-items {
    margin-top: var(--notification-gap);
    padding-top: 2px;
    border-top: 1px solid var(--border);
    font-size: var(--notification-meta-size);
    line-height: 1.5;
    color: var(--notification-muted);
    font-variant-numeric: tabular-nums;
  }
  .single {
    border-top: 0;
    margin-top: 3px;
    padding-top: 0;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 230px;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
  }
  .item-row {
    display: grid;
    grid-template-columns: 14px minmax(0, 1fr) 28px;
    align-items: start;
    column-gap: 7px;
    padding: 7px 0;
  }
  .item-icon {
    display: grid;
    width: 14px;
    height: 16px;
    padding-top: 2px;
  }
  .item-icon > span {
    grid-area: 1 / 1;
  }
  .single .item-row,
  li:last-child .item-row {
    padding-bottom: 0;
  }
  [data-state='failed'] .item-icon {
    color: var(--danger);
  }
  [data-state='completed'] .item-icon {
    color: var(--notification-success);
  }
  .item-copy {
    min-width: 0;
  }
  strong {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--notification-copy-size);
    font-weight: 600;
    color: var(--notification-text);
  }
  p {
    margin: 1px 0 0;
    font-size: var(--notification-meta-size);
  }
  .item-error {
    margin-top: 3px;
    overflow-wrap: anywhere;
    color: var(--danger);
  }
  .item-warning {
    color: var(--notification-warning, var(--muted));
    overflow-wrap: anywhere;
  }
  .row-action {
    margin-top: -3px;
  }
  .quiet {
    opacity: 0.4;
  }
  .item-row:hover .quiet,
  .item-row:focus-within .quiet {
    opacity: 1;
  }
  nav {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 5px;
  }
  @media (hover: none) {
    .quiet {
      opacity: 1;
    }
  }
</style>
