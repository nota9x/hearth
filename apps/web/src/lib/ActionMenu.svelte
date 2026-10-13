<script lang="ts">
  import MoreHorizontal from '@lucide/svelte/icons/more-horizontal';
  import type { Snippet } from 'svelte';

  const {
    label,
    title = 'Actions',
    compact = false,
    children,
  }: {
    label: string;
    title?: string;
    compact?: boolean;
    children: Snippet<[() => void]>;
  } = $props();
  let menu: HTMLDetailsElement;
  let open = $state(false);
  let above = $state(false);
  function positionMenu() {
    if (!menu?.open) return;
    const panel = menu.querySelector<HTMLElement>('.action-popover');
    if (!panel) return;
    const trigger = menu.getBoundingClientRect();
    above =
      trigger.bottom + panel.offsetHeight + 8 > innerHeight &&
      trigger.top > panel.offsetHeight + 8;
  }
  function outside(event: PointerEvent) {
    if (
      menu?.open &&
      event.target instanceof Node &&
      !menu.contains(event.target)
    )
      menu.open = false;
  }
  function escape(event: KeyboardEvent) {
    if (!(event.key === 'Escape' && menu?.open)) {
      return;
    }

    closeMenu();
  }
  function closeMenu() {
    menu.open = false;
    menu.querySelector('summary')?.focus();
  }
</script>

<svelte:window
  onpointerdown={outside}
  onkeydown={escape}
  onresize={positionMenu}
/>
<details
  class="action-menu"
  name="item-actions"
  bind:this={menu}
  bind:open
  ontoggle={positionMenu}
>
  <summary class="icon-button" class:compact aria-label={label} {title}>
    <MoreHorizontal size={17} />
  </summary>
  <div class="action-popover" class:above inert={!open} aria-hidden={!open}>
    {@render children(closeMenu)}
  </div>
</details>

<style>
  .action-menu {
    position: relative;
  }
  summary {
    list-style: none;
    cursor: pointer;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  .action-popover {
    position: absolute;
    right: 0;
    top: 100%;
    z-index: 10;
    display: grid;
    gap: 0.125rem;
    width: 212px;
    padding: 0.375rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 12px 30px #0008;
    margin-top: 6px;
  }
  .action-popover.above {
    top: auto;
    bottom: calc(100% + 6px);
    margin-top: 0;
  }
  .action-popover :global(:is(button, a)) {
    display: flex;
    align-items: center;
    color: inherit;
    width: 100%;
    min-height: 38px;
    padding: 8px 10px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    --control-hover: var(--raised);
    font-size: 0.88rem;
    line-height: 1.4;
    text-align: left;
    justify-content: flex-start;
    gap: 10px;
  }
  .action-popover :global(svg) {
    flex-shrink: 0;
  }
  .action-popover
    :global(:is(button, a):hover:not(:disabled):not([aria-disabled='true'])) {
    background: var(--control-hover);
  }
  .action-popover :global(.menu-delete) {
    border-top: 1px solid var(--border);
    margin-top: 0.25rem;
    padding-top: 0.25rem;
  }
  .action-popover :global(button.danger) {
    color: var(--danger);
    --control-hover: color-mix(in srgb, var(--danger) 8%, transparent);
  }
  details[open] summary {
    background: var(--raised);
    color: var(--accent);
  }
  .action-popover
    :global(:is(button, a):active:not(:disabled):not([aria-disabled='true'])) {
    background: var(--control-pressed);
  }
  @supports selector(::details-content) {
    details::details-content {
      transition: content-visibility var(--motion-surface-out) allow-discrete;
    }
    .action-popover {
      opacity: 0;
      translate: 0 -6px;
      scale: 0.99;
      transform-origin: top right;
      pointer-events: none;
      transition:
        opacity var(--motion-surface-out) var(--motion-exit),
        translate var(--motion-surface-out) var(--motion-exit),
        scale var(--motion-surface-out) var(--motion-exit);
    }
    .action-popover.above {
      translate: 0 6px;
      transform-origin: bottom right;
    }
    details[open]::details-content {
      transition-duration: var(--motion-surface-in);
    }
    details[open] .action-popover {
      opacity: 1;
      translate: 0 0;
      scale: 1;
      pointer-events: auto;
      transition-duration: var(--motion-surface-in);
      transition-timing-function: var(--motion-enter);
    }
    @starting-style {
      details[open] .action-popover {
        opacity: 0;
        scale: 0.99;
        translate: 0 -6px;
      }
      details[open] .action-popover.above {
        translate: 0 6px;
      }
    }
  }
</style>
