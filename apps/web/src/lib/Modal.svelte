<script lang="ts">
  import X from '@lucide/svelte/icons/x';
  import { onMount, type Snippet } from 'svelte';

  import { fadeMotion, surfaceMotion } from '#lib/motion.ts';
  import { onNavigate } from '$app/navigation';

  const {
    title,
    onClose,
    children,
    busy = false,
    wide = false,
  }: {
    title: string;
    onClose: () => void;
    children: Snippet;
    busy?: boolean;
    wide?: boolean;
  } = $props();
  let dialog: HTMLDialogElement;
  let mounted = false;
  let outgoing = false;
  let leavingRoute = false;
  let previousFocus: Element | null = null;
  let outsidePress = false;
  function open() {
    outgoing = false;
    dialog.inert = false;
    dialog.removeAttribute('aria-hidden');
    if (!mounted || dialog.open) {
      return;
    }

    if (dialog.matches(':popover-open')) dialog.hidePopover();
    previousFocus = document.activeElement;
    dialog.showModal();
  }
  function close() {
    outgoing = true;
    dialog.inert = true;
    dialog.setAttribute('aria-hidden', 'true');
    const wasOpen = dialog.open;
    dialog.close();
    const parent = document.querySelector('dialog[open]');
    if (leavingRoute || !mounted) {
      if (dialog.matches(':popover-open')) dialog.hidePopover();
    } else if (wasOpen && parent) {
      // Retain nested exit presentation above the parent's native top layer.
      dialog.showPopover();
    }
    if (
      wasOpen &&
      !leavingRoute &&
      previousFocus instanceof HTMLElement &&
      previousFocus.isConnected &&
      !parent
    )
      previousFocus.focus({ preventScroll: true });
  }
  function dismiss() {
    if (busy) return;
    close();
    onClose();
  }
  function transition(node: HTMLElement, { backdrop = false } = {}) {
    const config = backdrop
      ? fadeMotion(node, { kind: 'backdrop' })
      : surfaceMotion(node, { kind: 'dialog', y: 8 });
    return (options: { direction?: 'in' | 'out' } = {}) => {
      if (options.direction === 'out') close();
      else open();
      return {
        ...config(options),
        ...(leavingRoute && { duration: 0 }),
      };
    };
  }
  onNavigate(({ from, to }) => {
    if (outgoing || from?.url.pathname === to?.url.pathname) {
      return;
    }

    leavingRoute = true;
    dialog.dataset.leavingRoute = '';
    onClose();
    close();
    const animations = dialog.getAnimations({ subtree: true });
    for (const animation of animations)
      if (Number.isFinite(animation.effect?.getComputedTiming().endTime))
        animation.finish();
  });
  onMount(() => {
    mounted = true;
    open();
    return () => {
      mounted = false;
      close();
    };
  });
</script>

<dialog
  class="modal-host"
  bind:this={dialog}
  onclose={() => {
    if (!outgoing && !dialog.open) onClose();
  }}
  aria-label={title}
  popover="manual"
  closedby={busy ? 'none' : 'any'}
  onpointerdown={(event) => (outsidePress = event.target === dialog)}
  onclick={(event) => {
    if (outsidePress && event.target === dialog) dismiss();
  }}
  oncancel={(event) => {
    event.preventDefault();
    dismiss();
  }}
>
  <div
    class="modal-backdrop"
    transition:transition|global={{ backdrop: true }}
  ></div>
  <div class="dialog-surface" class:wide transition:transition|global>
    <div class="dialog-heading">
      <h2>{title}</h2>
      <button
        class="icon-button"
        disabled={busy}
        onclick={dismiss}
        aria-label="Close dialog"
        title="Close"><X size={20} /></button
      >
    </div>
    {@render children()}
  </div>
</dialog>

<style>
  .wide {
    width: min(680px, calc(100vw - 32px));
  }
</style>
