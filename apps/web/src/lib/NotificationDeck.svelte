<script lang="ts">
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import CircleX from '@lucide/svelte/icons/circle-x';
  import Info from '@lucide/svelte/icons/info';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import X from '@lucide/svelte/icons/x';
  import { onMount, tick } from 'svelte';

  import { fadeMotion, surfaceMotion } from '#lib/motion.ts';
  import { revealMotion } from '#lib/reveal.svelte.ts';

  import Modal from './Modal.svelte';
  import NotificationItems from './NotificationItems.svelte';
  import { notify } from './notifications';
  import Spinner from './Spinner.svelte';

  const icons = {
    loading: Spinner,
    success: CircleCheck,
    info: Info,
    warning: TriangleAlert,
    error: CircleX,
  };
  const titles = {
    loading: 'In progress',
    success: 'Success',
    info: 'Heads up',
    warning: 'Warning',
    error: 'Something went wrong',
  };
  let expanded = $state<number | null>(null);
  let polite = $state({ id: 0, message: '' });
  let urgent = $state({ id: 0, message: '' });
  let announced: Record<number, string> = {};
  let announcementId = 0;
  let deck: HTMLDivElement;
  const confirmation = notify.confirmation;

  // Announce arrivals and completion, never progress ticks or stack promotions.
  $effect(() => {
    const arrivals = $notify
      .filter((card) => announced[card.id] !== card.kind)
      .toReversed();
    announced = Object.fromEntries($notify.map((card) => [card.id, card.kind]));
    if (arrivals.length === 0) return;
    for (const kind of ['polite', 'urgent']) {
      const group = arrivals.filter(
        (card) => (card.kind === 'error') === (kind === 'urgent'),
      );
      if (group.length === 0) continue;
      const announcement = {
        id: ++announcementId,
        message: group
          .map((card) => `${titles[card.kind]}. ${card.message}`)
          .join(' '),
      };
      if (kind === 'urgent') urgent = announcement;
      else polite = announcement;
    }
  });

  onMount(() => {
    document.addEventListener('visibilitychange', notify.resetClock);
    let frame: number;
    const update = (now: number) => {
      // Native modal dialogs are above the deck; don't expire feedback behind them.
      notify.tick(
        now,
        !!deck.querySelector(
          ':scope .active section:is(:hover, :focus-within)',
        ) ||
          document.hidden ||
          !!document.querySelector('dialog[open]'),
      );
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', notify.resetClock);
      notify.resetClock();
    };
  });

  function measure(node: HTMLElement) {
    const observer = new ResizeObserver(([entry]) => {
      if (!node.closest('.card-position')?.classList.contains('active')) return;
      deck.style.setProperty(
        '--height',
        `${entry.borderBoxSize[0].blockSize}px`,
      );
    });
    observer.observe(node);
    return () => observer.disconnect();
  }

  async function dismiss(id: number) {
    const previous = document.activeElement;
    const restore = deck.contains(previous);
    notify.dismiss(id);
    await tick();
    if (
      restore &&
      !document.querySelector('dialog[open]') &&
      (document.activeElement === previous ||
        document.activeElement === document.body)
    )
      deck.querySelector<HTMLButtonElement>(':scope .active button')?.focus();
  }
</script>

<div class="announcements" role="status" aria-live="polite" aria-atomic="true">
  {#key polite.id}{polite.message}{/key}
</div>
<div
  class="announcements"
  role="alert"
  aria-live="assertive"
  aria-atomic="true"
>
  {#key urgent.id}{urgent.message}{/key}
</div>
<div class="notification-deck" bind:this={deck} aria-label="Notifications">
  {#each $notify.slice(0, 4) as card, index (card.id)}
    <div
      class="card-position"
      class:active={index === 0}
      style:--depth={index}
      style:z-index={4 - index}
      aria-hidden={index !== 0}
      inert={index !== 0}
    >
      <div
        class="toast"
        class:background={index !== 0}
        data-kind={card.kind}
        onintrostart={(event) => {
          const position = event.currentTarget.parentElement!;
          position.inert = index !== 0;
          position.setAttribute('aria-hidden', String(index !== 0));
          position.classList.toggle('active', index === 0);
        }}
        onoutrostart={(event) => {
          const position = event.currentTarget.parentElement!;
          position.inert = true;
          position.setAttribute('aria-hidden', 'true');
          position.classList.remove('active');
        }}
        transition:surfaceMotion
      >
        {#if index === 0}
          {@const Icon = icons[card.kind]}
          {@const hasDetails = (card.items?.length ?? 0) > 1}
          {@const showDetails = expanded === card.id || !hasDetails}
          <section
            {@attach measure}
            aria-label={`${titles[card.kind]} notification`}
          >
            <div class="notification-header">
              <span class="feedback-icon state-icon"
                >{#key card.kind}<span transition:fadeMotion
                    ><Icon size={18} aria-hidden="true" /></span
                  >{/key}</span
              >
              <div class="copy">
                <strong>{titles[card.kind]}</strong>
                <p>{card.message}</p>
              </div>
              <div class="actions">
                {#if hasDetails}
                  <button
                    type="button"
                    class="icon-button compact"
                    class:expanded={expanded === card.id}
                    aria-label={expanded === card.id
                      ? 'Hide details'
                      : 'Show details'}
                    title={expanded === card.id
                      ? 'Hide details'
                      : 'Show details'}
                    aria-expanded={expanded === card.id}
                    aria-controls={`notification-details-${card.id}`}
                    onclick={() =>
                      (expanded = expanded === card.id ? null : card.id)}
                  >
                    <ChevronDown size={16} aria-hidden="true" />
                  </button>
                {/if}
                {#if card.kind === 'loading' && card.onCancel}
                  <button
                    type="button"
                    class="icon-button compact"
                    aria-label={card.cancellation?.confirmLabel ??
                      'Cancel Operation'}
                    title={card.cancellation?.confirmLabel ??
                      'Cancel Operation'}
                    onclick={() => notify.requestCancel(card.id)}
                    ><X size={16} aria-hidden="true" /></button
                  >
                {:else if card.kind !== 'loading'}
                  <button
                    type="button"
                    class="icon-button compact"
                    aria-label="Dismiss notification"
                    title="Dismiss notification"
                    onclick={() => dismiss(card.id)}
                    ><X size={16} aria-hidden="true" /></button
                  >
                {/if}
              </div>
            </div>
            {#if card.kind === 'loading' && card.progress !== undefined}
              <div
                class="notification-track operation-progress"
                transition:fadeMotion
                role="progressbar"
                aria-label={card.message}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.floor(card.progress)}
              >
                <div style:transform={`scaleX(${card.progress / 100})`}></div>
              </div>
            {/if}
            {#if card.guidance && !(card.items?.length === 1 && card.items[0].error === card.guidance)}<p
                transition:fadeMotion={{ kind: 'content' }}
                class="supporting"
              >
                {card.guidance}
              </p>{/if}
            {#if card.link}<a class="notification-link" href={card.link.href}
                >{card.link.label} <span aria-hidden="true">→</span></a
              >{/if}
            <div
              id={`notification-details-${card.id}`}
              class="notification-details"
              {@attach revealMotion(() => showDetails)}
              inert={!showDetails}
              aria-hidden={!showDetails}
            >
              <div>
                {#if card.metadata && (card.kind === 'loading' || hasDetails)}<p
                    class="supporting"
                  >
                    {card.metadata}
                  </p>{/if}
                {#if card.items?.length && (hasDetails || card.kind === 'loading' || card.kind === 'error' || card.items[0].action || card.items[0].error)}
                  <NotificationItems
                    items={card.items}
                    label={card.itemsLabel}
                    visible={showDetails}
                    onCancel={(itemId: string) =>
                      notify.requestCancel(card.id, itemId)}
                  />
                {/if}
              </div>
            </div>
            {#if card.kind !== 'loading'}<div
                class="notification-track expiration-progress"
                aria-hidden="true"
              >
                <div
                  style:transform={`scaleX(${card.remaining / card.duration})`}
                ></div>
              </div>{/if}
          </section>
        {/if}
      </div>
    </div>
  {/each}
  {#if $notify.length > 4}<span class="overflow-count" aria-hidden="true"
      >+{$notify.length - 4} waiting</span
    >{/if}
</div>

{#if $confirmation}
  <Modal title={$confirmation.details.title} onClose={notify.keepRunning}>
    <form
      class="form-grid"
      onsubmit={(event) => {
        event.preventDefault();
        notify.confirmCancel();
      }}
    >
      <p>{$confirmation.details.message}</p>
      <div class="dialog-actions">
        <button type="button" onclick={notify.keepRunning}
          >{$confirmation.details.keepLabel}</button
        >
        <button type="submit" class="danger"
          >{$confirmation.details.confirmLabel}</button
        >
      </div>
    </form>
  </Modal>
{/if}

<style>
  .notification-link {
    display: inline-block;
    margin: 8px 0 0 27px;
    font-size: 12px;
    color: #edb58e;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .notification-deck {
    --height: 120px;
    position: fixed;
    top: max(24px, env(safe-area-inset-top));
    right: max(24px, env(safe-area-inset-right));
    width: min(380px, calc(100vw - 48px));
    z-index: 40;
    pointer-events: none;
  }
  .card-position {
    position: absolute;
    top: 0;
    width: 100%;
    transform: translateY(calc(var(--depth) * 8px))
      scale(calc(1 - var(--depth) * 0.018));
    transform-origin: bottom center;
    transition: transform var(--motion-surface-in) var(--motion-enter);
  }
  .toast {
    --tone: #d49a72;
    --notification-text: #f0e2d1;
    --notification-muted: var(--muted);
    --notification-success: #b8bf96;
    --notification-copy-size: 12px;
    --notification-meta-size: 11px;
    --notification-gap: 10px;
    background: #28221d;
    border: 1px solid #74604b;
    border-radius: 16px;
    box-shadow: 0 8px 22px #09070528;
    overflow: hidden;
  }
  .toast[data-kind='success'] {
    --tone: var(--notification-success);
  }
  .toast[data-kind='info'] {
    --tone: #d49a72;
  }
  .toast[data-kind='warning'] {
    --tone: #ddbb7b;
  }
  .toast[data-kind='error'] {
    --tone: var(--danger);
  }
  .background {
    height: var(--height);
    background: #302820;
    border-color: #685542;
  }
  section {
    position: relative;
    padding: 14px;
    pointer-events: auto;
    max-height: calc(100dvh - 100px);
    overflow-y: auto;
  }
  section:has(.notification-track) {
    padding-bottom: 9px;
  }
  .notification-header {
    display: flex;
    gap: 9px;
    align-items: flex-start;
  }
  .actions {
    display: flex;
    gap: 2px;
    margin: -2px -4px 0 0;
  }
  .expanded :global(svg) {
    transform: rotate(180deg);
  }
  .actions button :global(svg) {
    transition: transform var(--motion-state) var(--motion-enter);
  }
  section :global(.state-icon) {
    color: var(--tone);
    flex-shrink: 0;
    margin-top: 3px;
  }
  .copy {
    min-width: 0;
    flex: 1;
    overflow-wrap: anywhere;
  }
  strong {
    font-size: 13px;
    font-weight: 650;
    color: var(--notification-text);
  }
  p {
    margin: 2px 0 0;
    font-size: var(--notification-copy-size);
    line-height: 1.5;
    color: #c9b8a5;
  }
  .supporting {
    margin: 7px 0 0 27px;
    font-size: var(--notification-meta-size);
    color: var(--notification-muted);
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }
  .notification-details {
    overflow: hidden;
  }
  .notification-details > div {
    display: flow-root;
  }
  .notification-track {
    margin: 11px 2px 0;
    height: 2px;
    background: #e8d5bc12;
    border-radius: 2px;
    overflow: hidden;
  }
  .notification-track div {
    height: 100%;
    background: var(--tone);
    opacity: 0.7;
    transform-origin: left;
  }
  .operation-progress div {
    transition: transform var(--motion-state) linear;
  }
  .overflow-count {
    position: absolute;
    right: 12px;
    top: calc(var(--height) + 29px);
    font-size: 10px;
    color: #c9b8a5;
    background: #211b17;
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1px 8px;
  }
  .announcements {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  @media (max-width: 600px) {
    .notification-deck {
      top: max(12px, env(safe-area-inset-top));
      right: max(12px, env(safe-area-inset-right));
      width: min(380px, calc(100vw - 24px));
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .expiration-progress {
      visibility: hidden;
    }
  }
</style>
