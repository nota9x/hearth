<script lang="ts">
  import { dateTime, relativeExpiry } from '@hearth/core/common';
  import { linkStatus, linkStatuses } from '@hearth/core/link-search';
  import Check from '@lucide/svelte/icons/check';
  import Clock from '@lucide/svelte/icons/clock';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import Trash2 from '@lucide/svelte/icons/trash-2';

  import ActionMenu from './ActionMenu.svelte';
  import Copy from './Copy.svelte';

  const {
    link,
    admin = false,
    now,
    selected = false,
    select,
    disabled = false,
    edit,
    remove,
    primary,
  }: {
    link: {
      imageId: string;
      filename: string;
      url: string;
      slug: string;
      primary: boolean;
      createdAt: number;
      expiresAt: number | null;
      imageExpiresAt: number | null;
      effectiveExpiresAt: number | null;
      available: boolean;
      owner: string;
      ownerId: string | null;
      width: number;
      height: number;
    };
    admin?: boolean;
    now: number;
    selected?: boolean;
    select?: (checked: boolean) => void;
    disabled?: boolean;
    edit: () => void;
    remove: () => void;
    primary: () => void;
  } = $props();
  const status = $derived(
    linkStatus(link.effectiveExpiresAt, link.available, now),
  );
  const usable = $derived(status === 'active' || status === 'soon');
  const imageHref = $derived(`${admin ? '/admin' : ''}/images/${link.imageId}`);
</script>

<article class="row link-row" aria-label={`Share link ${link.slug}`}>
  {#if select}<input
      type="checkbox"
      checked={selected}
      {disabled}
      aria-label={`Select link ${link.slug}`}
      onchange={(event) => select?.(event.currentTarget.checked)}
    />{/if}
  <a class="link-preview" href={imageHref} aria-label={`View ${link.filename}`}
    ><img
      loading="lazy"
      src={`/api/media/${link.imageId}?preview`}
      alt=""
      width={link.width}
      height={link.height}
    /></a
  >
  <div class="row-content">
    <strong><a href={imageHref}>{link.filename}</a></strong>
    <span class="link-url" title={link.url}
      >{link.url.replace(/^https?:\/\//, '')}</span
    >
    <small
      ><time datetime={new Date(link.createdAt * 1000).toISOString()}
        >Created {dateTime(link.createdAt)}</time
      >{#if admin && link.ownerId}
        &nbsp;·&nbsp;<a href={`/admin/users/${link.ownerId}`}>{link.owner}</a
        >{/if}</small
    >
    <small
      title={`Link expiry: ${dateTime(link.expiresAt)} · Image expiry: ${dateTime(link.imageExpiresAt)}`}
    >
      {relativeExpiry(link.effectiveExpiresAt, now) ||
        'Never expires'}{#if link.imageExpiresAt !== null && (link.expiresAt === null || link.imageExpiresAt < link.expiresAt)}
        &nbsp;·&nbsp;Image expiry{/if}
    </small>
  </div>
  <div class="link-state">
    <span
      class="badge"
      data-status={status}
      title={status === 'unavailable'
        ? 'Domain or account disabled'
        : undefined}>{linkStatuses[status]}</span
    >{#if link.primary}<span class="badge">Primary</span>{/if}
  </div>
  <div class="row-actions">
    <Copy text={link.url} {disabled} />
    {#if usable}<a
        class="icon-button"
        href={link.url}
        target="_blank"
        rel="noreferrer"
        aria-label="Open link"
        title="Open link"><ExternalLink size={17} /></a
      >{:else}<span
        class="icon-button"
        aria-disabled="true"
        title="Link unavailable"><ExternalLink size={17} /></span
      >{/if}
    <ActionMenu label={`Actions for ${link.slug}`} title="Link actions">
      {#snippet children(closeMenu: () => void)}
        <button
          {disabled}
          onclick={() => {
            closeMenu();
            edit();
          }}><Clock size={16} />Change expiry</button
        >
        <Copy
          text={link.slug}
          label="Copy slug"
          showLabel
          {disabled}
          oncopy={closeMenu}
        />
        {#if !link.primary}<button
            disabled={disabled || !usable}
            onclick={() => {
              closeMenu();
              primary();
            }}><Check size={16} />Make primary</button
          >{/if}
        <div class="menu-delete">
          <button
            class="danger"
            {disabled}
            onclick={() => {
              closeMenu();
              remove();
            }}><Trash2 size={16} />Delete share link</button
          >
        </div>
      {/snippet}
    </ActionMenu>
  </div>
</article>

<style>
  .link-row {
    padding: 1rem;
    gap: 1rem;
    position: relative;
  }
  .link-preview {
    width: 56px;
    height: 56px;
    flex-shrink: 0;
    border-radius: 8px;
    overflow: hidden;
    background: var(--page);
  }
  .link-preview img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .row-content {
    min-width: 0;
  }
  .link-url {
    font-size: 0.85rem;
    overflow-wrap: anywhere;
    color: var(--muted);
  }
  .link-state {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    max-width: 150px;
  }
  [data-status='expired'],
  [data-status='unavailable'] {
    color: #efbba8;
  }
  @media (max-width: 1023px) {
    .link-row {
      flex-wrap: wrap;
      gap: 0.75rem;
    }
    .row-content {
      flex-basis: calc(100% - 110px);
    }
    .link-state {
      max-width: none;
      flex: 1;
    }
    .row-actions {
      margin-left: auto;
      width: auto;
    }
  }
</style>
