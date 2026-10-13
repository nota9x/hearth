<script lang="ts">
  import Info from '@lucide/svelte/icons/info';
  import { onDestroy } from 'svelte';

  const { label, text }: { label: string; text: string } = $props();
  const id = $props.id();
  let panel: HTMLDivElement;
  let trigger: HTMLButtonElement;
  let pinned = false;
  let dismissed = false;
  let timer: ReturnType<typeof setTimeout>;

  function show() {
    clearTimeout(timer);
    if (!dismissed && !panel.matches(':popover-open'))
      panel.showPopover({ source: trigger });
  }
  function hide() {
    clearTimeout(timer);
    pinned = false;
    if (panel.matches(':popover-open')) panel.hidePopover();
  }
  function leave() {
    if (pinned) return;
    timer = setTimeout(() => {
      if (!trigger.matches(':focus-visible')) hide();
    }, 120);
  }
  onDestroy(() => clearTimeout(timer));
</script>

<button
  bind:this={trigger}
  type="button"
  class="settings-info"
  aria-label={`About ${label.toLowerCase()}`}
  aria-describedby={id}
  popovertarget={id}
  onpointerenter={(event) => {
    if (event.pointerType !== 'mouse') return;
    dismissed = false;
    show();
  }}
  onpointerleave={() => {
    dismissed = false;
    leave();
  }}
  onfocus={() => {
    if (!trigger.matches(':focus-visible')) {
      return;
    }

    dismissed = false;
    show();
  }}
  onblur={() => {
    dismissed = false;
    leave();
  }}
  onclick={(event) => {
    event.preventDefault();
    if (pinned) hide();
    else {
      dismissed = false;
      pinned = true;
      show();
    }
  }}><Info size={15} /></button
>
<div
  bind:this={panel}
  {id}
  role="tooltip"
  popover="auto"
  class="settings-tooltip"
  onbeforetoggle={(event) => {
    if (event.newState !== 'closed') {
      return;
    }

    pinned = false;
    dismissed = true;
    clearTimeout(timer);
  }}
  onpointerenter={() => clearTimeout(timer)}
  onpointerleave={leave}
>
  {text}
</div>

<style>
  .settings-info {
    padding: 0;
    width: 32px;
    min-height: 32px;
    flex: 0 0 32px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--muted);
  }
  .settings-info:hover,
  .settings-info:focus-visible {
    color: var(--accent);
  }
  .settings-tooltip {
    position: fixed;
    position-area: bottom span-right;
    position-try-fallbacks:
      flip-inline,
      flip-block,
      flip-inline flip-block;
    margin: 8px;
    inset: auto;
    width: min(320px, calc(100vw - 32px));
    max-height: calc(100dvh - 32px);
    overflow-y: auto;
    padding: 13px 16px;
    border: 1px solid color-mix(in srgb, var(--muted) 30%, transparent);
    border-radius: 10px;
    background: var(--raised);
    color: var(--text, #e8ddd0);
    font-size: 0.8rem;
    line-height: 1.65;
    box-shadow: 0 8px 28px #0006;
    opacity: 0;
    transform: translateY(-3px);
    transition:
      opacity var(--motion-surface-out) var(--motion-exit),
      transform var(--motion-surface-out) var(--motion-exit),
      display var(--motion-surface-out) allow-discrete,
      overlay var(--motion-surface-out) allow-discrete;
  }
  .settings-tooltip:popover-open {
    opacity: 1;
    transform: translateY(0);
    transition-duration: var(--motion-surface-in);
    transition-timing-function: var(--motion-enter);
  }
  @starting-style {
    .settings-tooltip:popover-open {
      opacity: 0;
      transform: translateY(-3px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .settings-tooltip {
      transition: none;
      transform: none;
    }
  }
  @media (pointer: coarse) {
    .settings-info {
      min-height: 44px;
      width: 44px;
      flex-basis: 44px;
    }
  }
</style>
