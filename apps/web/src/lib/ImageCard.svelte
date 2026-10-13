<script lang="ts">
  import { bytes, dateTime, relativeExpiry } from '@hearth/core/common';
  import type { CollectionImage } from '@hearth/core/image-collection';
  import { highlightParts } from '@hearth/core/image-search';
  import Clock from '@lucide/svelte/icons/clock';
  import Download from '@lucide/svelte/icons/download';
  import Plus from '@lucide/svelte/icons/plus';
  import Trash2 from '@lucide/svelte/icons/trash-2';

  import { navigating } from '$app/state';

  import ActionMenu from './ActionMenu.svelte';
  import Copy from './Copy.svelte';
  import { downloadImages, downloads } from './downloads';

  const {
    image,
    href,
    admin = false,
    query = '',
    expiryNow,
    busy = false,
    pending = false,
    selected = false,
    select,
    edit,
    createLink,
    remove,
  }: {
    image: CollectionImage;
    href: string;
    admin?: boolean;
    query?: string;
    expiryNow: number;
    busy?: boolean;
    pending?: boolean;
    selected?: boolean;
    select?: (checked: boolean) => void;
    edit: () => void;
    createLink: () => void;
    remove: () => void;
  } = $props();
</script>

<article class="image-card">
  <div class="image-preview">
    <a {href}
      ><img
        loading="lazy"
        src={`/api/media/${image.id}?preview`}
        alt={image.filename}
        width={image.width}
        height={image.height}
      /></a
    >{#if select}<label class="image-select"
        ><input
          type="checkbox"
          value={image.id}
          checked={selected}
          onchange={(event) => select?.(event.currentTarget.checked)}
          disabled={busy || !!navigating.to}
          aria-label={`Select ${image.filename}`}
        /></label
      >{/if}
  </div>
  <div class="image-meta">
    <a {href}
      ><h3>
        {#each highlightParts(image.filename, query) as part, index (index)}{#if part.match}<mark
              >{part.text}</mark
            >{:else}{part.text}{/if}{/each}
      </h3></a
    >
    <div class="image-details">
      <span>{bytes(image.size)}&nbsp;·&nbsp;{image.width} × {image.height}</span
      >
      <time
        datetime={new Date(image.createdAt * 1000).toISOString()}
        title={`Uploaded ${dateTime(image.createdAt)}`}
        >{dateTime(image.createdAt)}</time
      >
      {#if admin}<a
          class="image-owner"
          href={`/admin/users/${image.ownerId}`}
          title={image.owner}>{image.owner}</a
        >{/if}
    </div>
    <div class="image-footer">
      {#if image.expiresAt !== null}<span
          class="image-expiry"
          title={dateTime(image.expiresAt)}
          ><Clock size={12} />{image.expiresAt <= expiryNow
            ? 'Pending deletion'
            : relativeExpiry(image.expiresAt, expiryNow)}</span
        >{/if}
      <div class="image-actions">
        <ActionMenu
          label={`Actions for ${image.filename}`}
          title="Image actions"
          compact
        >
          {#snippet children(closeMenu: () => void)}
            <button
              disabled={busy || !!navigating.to || pending}
              onclick={() => {
                closeMenu();
                edit();
              }}><Clock size={16} />Change expiry</button
            >
            <button
              disabled={busy ||
                !!navigating.to ||
                pending ||
                image.ownerStatus !== 'active'}
              onclick={() => {
                closeMenu();
                createLink();
              }}><Plus size={16} />Create share link</button
            >
            <Copy
              text={image.id}
              label="Copy image ID"
              showLabel
              oncopy={closeMenu}
            />
            <div class="menu-delete">
              <button
                class="danger"
                disabled={busy || !!navigating.to || pending}
                onclick={() => {
                  closeMenu();
                  remove();
                }}><Trash2 size={16} />Delete image</button
              >
            </div>
          {/snippet}
        </ActionMenu>
        {#if image.url}<Copy text={image.url} compact />{:else}<button
            class="icon-button compact"
            aria-label="Create share link"
            title="Create share link"
            disabled={busy || pending || image.ownerStatus !== 'active'}
            onclick={() => createLink()}><Plus size={17} /></button
          >{/if}
        <button
          class="icon-button compact"
          type="button"
          aria-label="Download"
          title="Download"
          disabled={$downloads.active}
          onclick={() => downloadImages([image.id])}
          ><Download size={17} /></button
        >
      </div>
    </div>
  </div>
</article>
