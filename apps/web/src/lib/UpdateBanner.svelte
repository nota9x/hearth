<script lang="ts">
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import X from '@lucide/svelte/icons/x';

  import { pendingActions } from '#lib/client.ts';
  import { downloads } from '#lib/downloads.ts';
  import { uploads } from '#lib/uploads.ts';
  import { updated } from '$app/state';

  let dismissed = $state(false);
  const busy = $derived($uploads || $downloads.active || $pendingActions > 0);
</script>

{#if updated.current && !dismissed}
  <section class="update-banner" aria-label="Application update">
    <Sparkles size={20} aria-hidden="true" />
    <div class="message" role="status">
      <strong>A fresh version of Hearth is ready.</strong>
      <span
        >{busy
          ? 'Reload once your current activity finishes.'
          : 'Reload to get the latest improvements.'}</span
      >
    </div>
    <div class="actions">
      <button class="primary" disabled={busy} onclick={() => location.reload()}>
        <RefreshCw size={15} aria-hidden="true" />Reload
      </button>
      <button
        class="icon-button"
        aria-label="Dismiss update notice"
        onclick={() => (dismissed = true)}
      >
        <X size={18} aria-hidden="true" />
      </button>
    </div>
  </section>
{/if}

<style>
  .update-banner {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px 24px;
    background: color-mix(in srgb, var(--accent) 12%, var(--surface));
    border-bottom: 1px solid color-mix(in srgb, var(--accent) 32%, transparent);
  }
  .update-banner > :global(svg) {
    color: #e5a780;
    flex-shrink: 0;
  }
  .message {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 2px 12px;
    font-size: 0.85rem;
  }
  .message strong {
    font-weight: 600;
  }
  .message span {
    color: var(--muted);
    font-size: 0.8rem;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-left: auto;
    flex-shrink: 0;
  }
  .actions button {
    font-size: 0.8rem;
  }
  @media (max-width: 767px) {
    .update-banner {
      padding: 12px 16px;
      gap: 12px;
      flex-wrap: wrap;
    }
    .message {
      flex: 1;
    }
    .actions {
      margin-left: 32px;
    }
  }
</style>
