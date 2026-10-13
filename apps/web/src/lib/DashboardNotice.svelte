<script lang="ts">
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import HardDrive from '@lucide/svelte/icons/hard-drive';
  import LockKeyhole from '@lucide/svelte/icons/lock-keyhole';

  import { fadeMotion } from '#lib/motion.ts';

  import type { PageData } from '../routes/[...path]/$types';

  const {
    data,
  }: {
    data: Pick<
      PageData,
      'user' | 'storageWarnings' | 'deliverySelection' | 'section'
    >;
  } = $props();
  const storageNotice = $derived.by(() => {
    const { personal, instance } = data.storageWarnings;
    const order =
      data.user.role === 'admin'
        ? (['instance', 'personal'] as const)
        : (['personal', 'instance'] as const);
    for (const severity of ['full', 'nearly-full'] as const) {
      const scope = order.find(
        (scope) => data.storageWarnings[scope] === severity,
      );
      if (!scope) continue;
      if (scope === 'personal')
        return {
          message:
            personal === 'full'
              ? 'Your storage is full. Delete some images to continue uploading.'
              : 'Your storage is nearly full. Delete some images to free space.',
          href: '/images',
          action: 'Manage images',
        };
      const admin = data.user.role === 'admin';
      return {
        message:
          instance === 'full'
            ? `Instance storage is full. New uploads are temporarily unavailable.${admin ? '' : ' Please try again later.'}`
            : 'Instance storage is nearly full. Uploads may soon be unavailable.',
        href: admin ? '/admin/storage' : null,
        action: 'Manage storage',
      };
    }
    return null;
  });
</script>

<div role="status" aria-live="polite" aria-atomic="true">
  {#if storageNotice || (data.deliverySelection.warning && data.section !== 'domains')}<div
      transition:fadeMotion={{ kind: 'content' }}
      class="notice delivery-notice"
    >
      <span class="delivery-notice-message"
        >{#if storageNotice}<HardDrive
            size={16}
            aria-hidden="true"
          />{storageNotice.message}{:else}<LockKeyhole
            size={16}
            aria-hidden="true"
          />Uploads will save privately.{/if}</span
      >
      {#if !storageNotice || storageNotice.href}
        <a
          class="delivery-notice-action"
          href={storageNotice?.href ?? '/domains'}
          >{storageNotice?.action ?? 'Configure delivery'}
          <ArrowRight size={14} aria-hidden="true" /></a
        >
      {/if}
    </div>{/if}
</div>

<style>
  .delivery-notice {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 24px;
    padding: 10px 16px;
    background: #c4714a08;
    border-color: #c4714a24;
    color: var(--muted);
    font-size: 0.8rem;
  }
  .delivery-notice-message {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .delivery-notice-message :global(svg) {
    flex-shrink: 0;
    color: #dfac87;
  }
  .delivery-notice-action {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 28px;
    margin-left: auto;
    padding-left: 16px;
    border-left: 1px solid #c4714a24;
    color: #dda07a;
    white-space: nowrap;
  }
  .delivery-notice-action:hover {
    color: #e6b693;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .delivery-notice-action:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 4px;
    border-radius: 2px;
  }
  @media (max-width: 480px) {
    .delivery-notice-action {
      margin-left: 26px;
      padding-left: 0;
      border-left: 0;
    }
  }
</style>
