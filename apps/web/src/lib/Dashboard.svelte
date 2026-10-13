<script lang="ts">
  import { bytes, dateTime, relativeExpiry } from '@hearth/core/common';
  import { expiryChoices } from '@hearth/core/expiry-policy';
  import { filterKeys } from '@hearth/core/image-search';
  import type { imageExpiryOptions } from '@hearth/core/images';
  import {
    linkExpiryFilters,
    linkFilterKeys,
    linkSortOptions,
    linkStatuses,
  } from '@hearth/core/link-search';
  import type { linkCreationOptions } from '@hearth/core/links';
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
  import Clock from '@lucide/svelte/icons/clock';
  import Download from '@lucide/svelte/icons/download';
  import HardDrive from '@lucide/svelte/icons/hard-drive';
  import Image from '@lucide/svelte/icons/image';
  import KeyRound from '@lucide/svelte/icons/key-round';
  import Link from '@lucide/svelte/icons/link';
  import Plus from '@lucide/svelte/icons/plus';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Upload from '@lucide/svelte/icons/upload';
  import { untrack } from 'svelte';

  import { afterNavigate, goto } from '$app/navigation';
  import { navigating, page } from '$app/state';
  import type { AdminComponents } from '$lib/admin-types';
  import BackLink from '$lib/BackLink.svelte';
  import BulkActions from '$lib/BulkActions.svelte';
  import { action } from '$lib/client';
  import { copyText } from '$lib/clipboard';
  import CollectionEmpty from '$lib/CollectionEmpty.svelte';
  import CollectionHeader from '$lib/CollectionHeader.svelte';
  import { dashboard } from '$lib/dashboard';
  import DashboardNotice from '$lib/DashboardNotice.svelte';
  import {
    deleteSelectedImages,
    imageDeletion,
    linkDeletion,
    reconcileDeletedImages,
  } from '$lib/deletion';
  import { downloadImages, downloads } from '$lib/downloads';
  import ExpiryFields from '$lib/ExpiryFields.svelte';
  import ImageCard from '$lib/ImageCard.svelte';
  import ImageSearch from '$lib/ImageSearch.svelte';
  import LinkRow from '$lib/LinkRow.svelte';
  import Modal from '$lib/Modal.svelte';
  import { fadeMotion } from '$lib/motion';
  import { notify } from '$lib/notifications';
  import Pagination from '$lib/Pagination.svelte';
  import { refreshInterval, watchRefresh } from '$lib/refresh';
  import SearchControls from '$lib/SearchControls.svelte';
  import { reconcileSelection } from '$lib/selection';
  import ShareXConfig from '$lib/ShareXConfig.svelte';
  import Statistics from '$lib/Statistics.svelte';
  import { uploads } from '$lib/uploads';
  import UserDomains from '$lib/UserDomains.svelte';

  import type { PageData } from '../routes/[...path]/$types';

  const {
    data,
    adminComponents,
  }: { data: PageData; adminComponents?: AdminComponents } = $props();
  let error = $state(''),
    busy = $state(false),
    modal = $state(''),
    selected = $state<string[]>([]),
    selectionAcrossPages = $state(false),
    selectingAll = $state(false),
    target = $state('');
  let expiry = $state('never'),
    customDate = $state(''),
    slug = $state(''),
    deliveryDomainId = $state('');
  let adminModal = $state('');
  let uploadInput: HTMLInputElement;
  const titles: Record<string, string> = {
    overview: 'Overview',
    images: 'Images',
    links: 'Links',
    domains: 'Domains',
    settings: 'Settings',
  };
  let expiryNow = $state(Math.floor(Date.now() / 1000));
  const isFiltered = $derived(
    !!data.search ||
      (data.section === 'links' ? linkFilterKeys : filterKeys).some((key) =>
        page.url.searchParams.has(key),
      ),
  );
  let expiryOptions = $state<Awaited<
    ReturnType<typeof imageExpiryOptions>
  > | null>(null);
  let expiryOptionsLoading = $state(false);
  const editChoices = $derived(
    ['expiry', 'link-expiry', 'alias'].includes(modal) && expiryOptions
      ? expiryChoices(
          expiryOptions.policy,
          modal === 'alias' ? null : expiryOptions.deadline,
          expiryNow,
        )
      : [],
  );
  let creationOptions = $state<Awaited<
    ReturnType<typeof linkCreationOptions>
  > | null>(null);
  const linkFilters = $derived([
    {
      key: 'status',
      label: 'Status',
      placeholder: 'All statuses',
      options: linkStatuses,
    },
    {
      key: 'expiry',
      label: 'Expiry',
      placeholder: 'Any expiry',
      options: linkExpiryFilters,
    },
    {
      key: 'domain',
      label: 'Delivery domain',
      placeholder: 'All domains',
      options: Object.fromEntries(
        data.linkDeliveryDomains.map((h) => [h.id, h.hostname]),
      ),
    },
    ...(data.admin
      ? [
          {
            key: 'owner',
            label: 'Owner',
            placeholder: 'All owners',
            options: Object.fromEntries(
              data.linkOwners.map((u) => [u.id, u.name]),
            ),
          },
        ]
      : []),
    ...(page.url.searchParams.has('image')
      ? [
          {
            key: 'image',
            label: 'Image',
            placeholder: 'All images',
            options: {
              [page.url.searchParams.get('image')!]:
                data.linkImage?.filename ?? 'Selected image',
            },
          },
        ]
      : []),
  ]);
  let expiryRequest = 0;
  const displayedImages = $derived(
    data.images.filter((image) => !$imageDeletion.removed.includes(image.id)),
  );
  const linkDeletionState = linkDeletion.state;
  const displayedLinks = $derived(
    data.links.filter((link) => !$linkDeletionState.removed.includes(link.id)),
  );
  const managingLinks = $derived(data.section === 'links' || !!data.image);
  const deletingSelection = $derived(
    selected.some((id) =>
      (managingLinks
        ? $linkDeletionState.pending
        : $imageDeletion.pending
      ).includes(id),
    ),
  );
  const visibleItems = $derived(
    data.section === 'images' && !data.image
      ? displayedImages.map((image) => image.id)
      : managingLinks
        ? displayedLinks.map((link) => link.id)
        : [],
  );
  const pollingInterval = $derived(
    refreshInterval(
      data.section,
      data.admin,
      !!data.image,
      $uploads || data.runs.some((run) => run.status === 'running'),
    ),
  );

  afterNavigate(({ from, to }) => {
    if (
      from?.url.pathname !== to?.url.pathname ||
      (from?.url.href !== to?.url.href &&
        (!selectionAcrossPages ||
          selectionCriteria(from?.url) !== selectionCriteria(to?.url)))
    ) {
      selected = [];
      selectionAcrossPages = false;
    }
    if (from?.url.pathname === to?.url.pathname) return;
  });
  $effect(() => {
    if (
      !['images', 'overview', 'links'].includes(data.section) &&
      !data.image &&
      !data.member
    )
      return;
    if (
      !['expiry', 'link-expiry', 'alias'].includes(modal) &&
      !data.image?.expiresAt &&
      displayedImages.every((image) => image.expiresAt === null) &&
      displayedLinks.every((link) => link.effectiveExpiresAt === null)
    )
      return;
    expiryNow = Math.floor(Date.now() / 1000);
    return watchRefresh(
      () => {
        expiryNow = Math.floor(Date.now() / 1000);
      },
      () => true,
      ['expiry', 'link-expiry', 'alias'].includes(modal) ? 1000 : 30_000,
    );
  });
  $effect(() => {
    const imageIds = data.images.map((image) => image.id);
    const linkIds = data.links.map((link) => link.id);
    untrack(() => linkDeletion.reconcile(linkIds));
    untrack(() => reconcileDeletedImages(imageIds));
  });
  $effect(() => {
    const visible = visibleItems;
    const removed = new Set(
      managingLinks ? $linkDeletionState.removed : $imageDeletion.removed,
    );
    untrack(() => {
      selected = selectionAcrossPages
        ? selected.filter((id) => !removed.has(id))
        : reconcileSelection(selected, visible);
    });
  });
  $effect(() => {
    return watchRefresh(
      () => {
        void dashboard.refresh().catch(() => {});
      },
      () => !busy && !modal && !adminModal && !navigating.to,
      pollingInterval,
    );
  });
  async function manualRefresh() {
    try {
      await dashboard.refresh();
      notify.success('Dashboard refreshed.');
    } catch {
      notify.error('Could not refresh. Please try again.');
    }
  }
  function selectionCriteria(url: URL | undefined) {
    if (!url) return '';
    const next = new URL(url);
    next.searchParams.delete('page');
    next.searchParams.delete('linkPage');
    return next.href;
  }
  function clearSelection() {
    selected = [];
    selectionAcrossPages = false;
  }
  async function copyLinks() {
    busy = true;
    try {
      const urls: Record<string, string> = {};
      for (let offset = 0; offset < selected.length; offset += 100) {
        const result = await action<{ links: { id: string; url: string }[] }>(
          'alias-copy',
          { ids: selected.slice(offset, offset + 100) },
        );
        for (const link of result.links) urls[link.id] = link.url;
      }
      if (Object.keys(urls).length > 0)
        await copyText(
          selected
            .filter((id) => urls[id])
            .map((id) => urls[id])
            .join('\n'),
          `${Object.keys(urls).length} links copied`,
        );
      if (Object.keys(urls).length !== selected.length) {
        notify.error(
          'Some selected links were removed. Refresh your selection.',
        );
        await dashboard.refresh(true);
      }
    } catch (error) {
      notify.error(
        error instanceof Error ? error.message : 'Could not copy links.',
      );
    } finally {
      busy = false;
    }
  }
  async function selectAll() {
    selectingAll = true;
    const href = page.url.href;
    try {
      const result = await action<{ ids: string[] }>(
        managingLinks ? 'alias-select-all' : 'image-select-all',
        {
          admin: data.admin,
          query: data.image
            ? new URLSearchParams({ image: data.image.id }).toString()
            : page.url.search,
        },
      );
      if (page.url.href === href) {
        selectionAcrossPages = true;
        selected = result.ids.filter(
          (id) =>
            !(
              managingLinks
                ? $linkDeletionState.removed
                : $imageDeletion.removed
            ).includes(id),
        );
      }
    } catch (error) {
      notify.error(
        error instanceof Error ? error.message : 'Could not select items.',
      );
    } finally {
      selectingAll = false;
    }
  }
  function imageListURL() {
    const url = new URL(page.url);
    url.searchParams.delete('linkPage');
    return `${data.admin ? '/admin' : ''}/images${url.search}`;
  }
  function searchLink(keys: string[]) {
    const url = new URL(page.url);
    for (const key of [...keys, 'page']) url.searchParams.delete(key);
    return url.pathname + url.search;
  }
  function open(name: string, id = '') {
    error = '';
    target = id;
    modal = name;
    expiry = 'never';
    customDate = '';
    deliveryDomainId = data.deliverySelection.domain?.id ?? '';
    slug = '';
    if (!['expiry', 'link-expiry', 'alias'].includes(name)) return;
    creationOptions = null;
    const request = ++expiryRequest;
    expiryNow = Math.floor(Date.now() / 1000);
    expiryOptions = null;
    expiryOptionsLoading = true;
    const selection = id ? [id] : [...selected];
    void action<Awaited<ReturnType<typeof imageExpiryOptions>>>(
      name === 'alias'
        ? 'alias-create-options'
        : name === 'link-expiry'
          ? 'alias-expiry-options'
          : 'image-expiry-options',
      name === 'alias' ? { imageId: id } : { ids: selection },
    )
      .then((options) => {
        if (modal !== name || target !== id || expiryRequest !== request)
          return;
        expiryOptions = options;
        if (name === 'alias') {
          creationOptions = options as Awaited<
            ReturnType<typeof linkCreationOptions>
          >;
          deliveryDomainId = creationOptions.selectedDeliveryDomainId ?? '';
        }
        expiry = options.choices[0]?.[0] ?? '';
      })
      .catch((error_: unknown) => {
        if (modal === name && target === id && expiryRequest === request)
          error =
            error_ instanceof Error
              ? error_.message
              : 'Could not load expiry choices.';
      })
      .finally(() => {
        if (modal === name && target === id && expiryRequest === request)
          expiryOptionsLoading = false;
      });
  }
  function close() {
    if (busy) return;
    expiryRequest++;
    modal = '';
  }
  async function run(
    name: string,
    input: Record<string, unknown>,
    message = 'Changes saved.',
  ) {
    busy = true;
    error = '';
    try {
      const result = await action(name, input);
      await dashboard.refresh(true);
      notify.success(message);
      return result;
    } catch (error_) {
      error = error_ instanceof Error ? error_.message : 'Please try again.';
      if (!modal) notify.error(error);
      return null;
    } finally {
      busy = false;
    }
  }
  async function confirm() {
    if (modal === 'delete') {
      const ids = target ? [target] : [...selected];
      const returnUrl = imageListURL();
      const detail = !!data.image;
      modal = '';
      const filenames = Object.fromEntries(
        data.images.map((image) => [image.id, image.filename]),
      );
      if (data.image) filenames[data.image.id] = data.image.filename;
      if (detail) await goto(returnUrl);
      void deleteSelectedImages(ids, filenames);
      return;
    }
    let result: Record<string, unknown> | null = null;
    if (modal === 'expiry' || modal === 'link-expiry')
      result = await run(
        modal === 'link-expiry' ? 'alias-expiry' : 'image-expiry',
        {
          ids: target ? [target] : selected,
          expiry,
          expiresAt: customDate
            ? new Date(customDate).toISOString()
            : undefined,
        },
      );
    if (modal === 'alias')
      result = await run(
        'alias-create',
        {
          imageId: target,
          deliveryDomainId,
          slug,
          expiry,
          expiresAt: customDate
            ? new Date(customDate).toISOString()
            : undefined,
        },
        'Link created.',
      );
    if (modal === 'alias-delete') {
      const ids = target ? [target] : [...selected];
      modal = '';
      void linkDeletion.remove(
        ids,
        Object.fromEntries(
          data.links.map((link) => [
            link.id,
            link.url.replace(/^https?:\/\//, ''),
          ]),
        ),
      );
      return;
    }
    if (!result) {
      return;
    }

    const completedModal = modal;
    clearSelection();
    close();
    if (
      data.image &&
      modal === '' &&
      !['alias', 'link-expiry', 'expiry'].includes(completedModal)
    )
      await goto(imageListURL());
  }
  function uploadFiles(files: FileList | null) {
    if (!files?.length || busy) return;
    const batch = [...files];
    uploadInput.value = '';
    void uploads.start(batch, () => dashboard.refresh(true));
  }
</script>

<svelte:head
  ><title
    >{data.admin ? 'Admin · ' : ''}{data.image?.filename || data.section} · {data.siteName}</title
  ></svelte:head
>
{#if adminComponents}<adminComponents.Tabs section={data.section} />{/if}
<input
  bind:this={uploadInput}
  type="file"
  accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
  multiple
  hidden
  onchange={() => uploadFiles(uploadInput.files)}
/>
<DashboardNotice {data} />
{#if data.image}
  <BackLink href={imageListURL()} label="Back to images" />
  <div class="page-top">
    <div>
      <h1>{data.image.filename}</h1>
    </div>
    <button
      disabled={$downloads.active}
      onclick={() => downloadImages([data.image!.id])}
      ><Download size={17} />Download</button
    >
  </div>
  <div class="detail-preview">
    <img src={`/api/media/${data.image.id}`} alt={data.image.filename} />
  </div>
  {#if data.admin}<p>
      Owner: <a class="subtle-link" href={`/admin/users/${data.image.ownerId}`}
        >{data.image.owner}</a
      >
    </p>{/if}
  <div class="detail-meta">
    <div><small>File size</small><strong>{bytes(data.image.size)}</strong></div>
    <div>
      <small>Dimensions</small><strong
        >{data.image.width} × {data.image.height}</strong
      >
    </div>
    <div>
      <small>Uploaded</small><strong>{dateTime(data.image.createdAt)}</strong>
    </div>
    <div>
      <small>Expiry</small><strong>{dateTime(data.image.expiresAt)}</strong>
      {#if data.image.expiresAt !== null}<small
          >{relativeExpiry(data.image.expiresAt, expiryNow).replace(
            /^Expires /,
            '',
          )}</small
        >{/if}
    </div>
  </div>
  <div class="toolbar">
    <button
      disabled={$imageDeletion.pending.includes(data.image.id)}
      onclick={() => open('expiry', data.image!.id)}
      ><Clock size={16} />Change expiry</button
    ><button
      class="danger"
      disabled={$imageDeletion.pending.includes(data.image.id)}
      onclick={() => open('delete', data.image!.id)}
      ><Trash2 size={16} />Delete image</button
    >
  </div>
  <div class="section-heading">
    <h2>Links to this image</h2>
    <button onclick={() => open('alias', data.image!.id)}
      ><Plus size={16} />Create link</button
    >
  </div>
  {@render linkActions()}
  {@render links()}
  {#if data.linkPagination.pages > 1}<Pagination
      current={data.linkPagination.page}
      pages={data.linkPagination.pages}
      total={data.linkTotal}
      size={data.linkPagination.size}
      parameter="linkPage"
    />{/if}
{:else if data.section === 'overview'}
  <CollectionHeader title={titles.overview} refresh={manualRefresh} {busy}>
    <button class="primary" disabled={busy} onclick={() => uploadInput.click()}
      ><Plus size={18} />Upload image</button
    >
  </CollectionHeader>
  {@render stats()}
  <div class="section-heading">
    <h2>Recent images</h2>
    <a href={data.admin ? '/admin/images' : '/images'}
      >View all images<ArrowRight size={16} /></a
    >
  </div>
  {@render gallery()}
  <div class="upload-callout">
    <KeyRound size={25} />
    <div>
      <h3>ShareX</h3>
      <p>Upload screenshots directly from ShareX.</p>
    </div>
    <button onclick={() => open('sxcu')}
      >Set up ShareX<ArrowUpRight size={16} /></button
    >
  </div>
{:else if data.section === 'images'}
  <CollectionHeader title={titles.images} refresh={manualRefresh} {busy}>
    <button class="primary" disabled={busy} onclick={() => uploadInput.click()}
      ><Plus size={18} />Upload image</button
    >
  </CollectionHeader>
  {#if data.scopedUser}<p>
      Owner: <a class="subtle-link" href={`/admin/users/${data.scopedUser.id}`}
        >{data.scopedUser.displayName}</a
      >
    </p>{/if}
  <ImageSearch
    total={data.total}
    unfilteredTotal={data.unfilteredTotal}
    deliveryDomains={data.imageDomains}
    admin={data.admin}
  />
  <BulkActions
    count={selected.length}
    noun="image"
    {selectAll}
    clear={clearSelection}
    disabled={busy || selectingAll || !!navigating.to}
  >
    <button disabled={deletingSelection || busy} onclick={() => open('expiry')}
      ><Clock size={16} />Change expiry</button
    >
    <button
      disabled={$downloads.active}
      onclick={() => downloadImages([...selected])}
      ><Download size={16} />Download</button
    >
    <button
      class="danger"
      disabled={deletingSelection || busy}
      onclick={() => open('delete')}><Trash2 size={16} />Delete</button
    >
  </BulkActions>
  {#if $downloads.individual.length}<div
      transition:fadeMotion={{ kind: 'content' }}
      class="notice"
    >
      This selection needs individual downloads in this browser.
      <button
        disabled={$downloads.active}
        onclick={() =>
          downloadImages(
            $downloads.individual.map((image) => image.id),
            true,
          )}><Download size={16} />Download individually</button
      >
      <button
        onclick={() =>
          downloads.update((state) => ({ ...state, individual: [] }))}
        >Clear</button
      >
    </div>{/if}
  {@render gallery()}<Pagination
    current={data.page}
    pages={data.imagePagination.pages}
    total={data.total}
    size={24}
  />
{:else if data.section === 'links'}
  <CollectionHeader title={titles.links} refresh={manualRefresh} {busy} />
  <SearchControls
    total={data.linkTotal}
    unfilteredTotal={data.linkUnfilteredTotal}
    noun="link"
    plural="links"
    dateLabel="Creation date"
    filters={linkFilters}
    sortOptions={linkSortOptions}
    timeZoneFilters={['expiry']}
  />
  {@render linkActions()}
  {@render links()}
  <Pagination
    current={data.linkPagination.page}
    pages={data.linkPagination.pages}
    total={data.linkTotal}
    size={data.linkPagination.size}
  />
{:else if data.section === 'domains'}
  {#if adminComponents}
    <adminComponents.Domains
      result={data.domainPage!}
      admin={data.admin}
      preferenceId={data.user.preferredDeliveryDomainId}
      selection={data.deliverySelection}
      available={data.allowed}
    />
  {:else}
    <UserDomains
      result={data.domainPage!}
      preferenceId={data.user.preferredDeliveryDomainId}
      selection={data.deliverySelection}
      available={data.allowed}
    />
  {/if}
{:else if adminComponents}
  <adminComponents.Sections
    {data}
    bind:busy
    bind:modal={adminModal}
    {run}
    {manualRefresh}
    {gallery}
  />
{/if}
{#snippet stats()}<Statistics
    items={[
      {
        label: 'Storage used',
        value: bytes(data.stats.bytes),
        icon: HardDrive,
      },
      { label: 'Images saved', value: data.stats.imageCount, icon: Image },
      {
        label: data.admin ? 'Uploads today' : 'Uploads this month',
        value: data.uploads,
        icon: Upload,
      },
      { label: 'Active links', value: data.activeLinks, icon: Link },
    ]}
  />{/snippet}
{#snippet gallery()}{#if displayedImages.length}<div
      class="gallery"
      class:preview-gallery={data.section === 'overview' || !!data.member}
    >
      {#each displayedImages as image (image.id)}<ImageCard
          {image}
          admin={data.admin}
          query={data.section === 'users' ? '' : data.search}
          {expiryNow}
          {busy}
          pending={$imageDeletion.pending.includes(image.id)}
          href={`${data.admin ? '/admin' : ''}/images/${image.id}${data.section === 'images' ? page.url.search : '?owner=' + image.ownerId}`}
          selected={selected.includes(image.id)}
          select={data.section === 'images'
            ? (checked) => {
                selected = checked
                  ? [...selected, image.id]
                  : selected.filter((id) => id !== image.id);
              }
            : undefined}
          edit={() => open('expiry', image.id)}
          createLink={() => open('alias', image.id)}
          remove={() => open('delete', image.id)}
        />{/each}
    </div>{:else}<CollectionEmpty
      title={isFiltered ? 'No images match your search.' : 'No images yet'}
      message={isFiltered
        ? 'Try another search or clear your filters.'
        : 'Upload an image or set up ShareX to automatically upload screenshots.'}
    >
      {#snippet icon()}<Image size={38} />{/snippet}
      {#if isFiltered}<div class="empty-search-actions">
          {#if data.search}<a class="button" href={searchLink(['q'])}
              >Clear search</a
            >{/if}
          {#if filterKeys.some((key) => page.url.searchParams.has(key))}<a
              class="button"
              href={searchLink([...filterKeys])}>Clear filters</a
            >{/if}
        </div>{:else}<button
          class="primary"
          disabled={busy}
          onclick={() => uploadInput.click()}
          ><Plus size={17} />Upload your first image</button
        >{/if}
    </CollectionEmpty>{/if}{/snippet}
{#snippet linkActions()}
  {#if displayedLinks.length}
    <BulkActions
      count={selected.length}
      noun="link"
      {selectAll}
      clear={clearSelection}
      disabled={busy || selectingAll || !!navigating.to}
    >
      <button
        disabled={deletingSelection || busy}
        onclick={() => open('link-expiry')}
        ><Clock size={16} />Change expiry</button
      >
      <button disabled={busy} onclick={copyLinks}
        ><Link size={16} />Copy links</button
      >
      <button
        class="danger"
        disabled={deletingSelection || busy}
        onclick={() => open('alias-delete')}><Trash2 size={16} />Delete</button
      >
    </BulkActions>
  {/if}
{/snippet}
{#snippet links()}
  <div class="rows" aria-busy={!!navigating.to}>
    {#each displayedLinks as link (link.id)}
      <LinkRow
        {link}
        admin={data.admin}
        now={expiryNow}
        selected={selected.includes(link.id)}
        select={(checked) => {
          selected = checked
            ? [...selected, link.id]
            : selected.filter((id) => id !== link.id);
        }}
        disabled={busy ||
          !!navigating.to ||
          $linkDeletionState.pending.includes(link.id)}
        edit={() => open('link-expiry', link.id)}
        remove={() => open('alias-delete', link.id)}
        primary={() => {
          void run('alias-primary', { id: link.id }, 'Primary link updated');
        }}
      />
    {:else}
      <CollectionEmpty
        title={data.image
          ? "This image isn't currently shared."
          : isFiltered
            ? 'No links match your search.'
            : 'No share links yet'}
        message={data.image
          ? 'The image remains stored and fully manageable.'
          : isFiltered
            ? 'Try another search or clear your filters.'
            : 'Images can exist without share links. Open an image to create one.'}
      >
        {#snippet icon()}<Link size={34} />{/snippet}
        {#if data.image}<button onclick={() => open('alias', data.image!.id)}
            ><Plus size={16} />Create share link</button
          >
        {:else if isFiltered}
          {#if data.search}<a class="button" href={searchLink(['q'])}
              >Clear search</a
            >{/if}
          <a class="button" href={searchLink([...linkFilterKeys])}
            >Clear filters</a
          >
        {:else}<a class="button" href={data.admin ? '/admin/images' : '/images'}
            >View images</a
          >{/if}
      </CollectionEmpty>
    {/each}
  </div>
{/snippet}

{#if modal}<Modal
    title={modal === 'alias'
      ? 'Create link'
      : modal === 'sxcu'
        ? 'Set up ShareX'
        : ['expiry', 'link-expiry'].includes(modal)
          ? 'Change expiry'
          : modal === 'delete'
            ? 'Delete images'
            : target
              ? 'Delete share link'
              : `Delete ${selected.length} share links?`}
    onClose={close}
    {busy}
  >
    {#if error}<p
        transition:fadeMotion={{ kind: 'content' }}
        class="error"
        role="alert"
      >
        {error}
      </p>{/if}
    {#if modal === 'sxcu'}
      <p>Enter your current API key to set up ShareX.</p>
      <ShareXConfig
        bind:busy
        onDownload={() => {
          busy = false;
          close();
          notify.success('ShareX configuration downloaded.');
        }}
      />
    {:else}<form
        class="form-grid"
        onsubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
      >
        {#if ['delete', 'alias-delete'].includes(modal)}<p>
            {modal === 'delete'
              ? 'This permanently removes the selected images and invalidates every public link.'
              : target &&
                  data.links.find((link) => link.id === target)?.linkCount === 1
                ? "This is the image's only share link. Deleting it will make the image unshared, but the image itself will remain stored."
                : 'These links will stop working, but the underlying images will remain stored in Hearth.'}
          </p>{/if}

        {#if modal === 'alias'}<label
            >Delivery domain<select
              bind:value={deliveryDomainId}
              required
              disabled={expiryOptionsLoading}
              ><option value="" disabled>Choose a delivery domain</option
              >{#each creationOptions?.deliveryDomains ?? [] as domain (domain.id)}<option
                  value={domain.id}>{domain.hostname}</option
                >{/each}</select
            ></label
          ><label
            >Slug<input
              bind:value={slug}
              pattern={'[a-z0-9][a-z0-9_-]{2,63}'}
              placeholder="Leave blank to generate a slug"
            /></label
          ><small
            >Leave the slug blank to generate a unique address. Expiring this
            link leaves the image stored.</small
          >
          {#if creationOptions && creationOptions.deliveryDomains.length === 0}<p
              in:fadeMotion={{ kind: 'content' }}
              class="error"
            >
              No delivery domains are available for this image's owner.
            </p>{/if}
          {#if creationOptions?.imageExpiresAt}<small
              >The image expires {dateTime(creationOptions.imageExpiresAt)};
              links cannot keep it available beyond that time.</small
            >{/if}
        {/if}
        {#if ['alias', 'expiry', 'link-expiry'].includes(modal)}
          <ExpiryFields
            bind:value={expiry}
            bind:customDate
            choices={editChoices}
            label={modal === 'expiry' ? 'Image expiry' : 'Link expiration'}
            deadline={modal === 'alias' &&
            expiryOptions?.policy.maxLifetimeSeconds != null
              ? expiryNow + expiryOptions.policy.maxLifetimeSeconds
              : (expiryOptions?.deadline ?? null)}
            loading={expiryOptionsLoading}
            origin={modal === 'expiry'
              ? 'image upload time'
              : 'link creation time'}
          />
        {/if}

        <div class="dialog-actions">
          <button type="button" onclick={close} disabled={busy}>Cancel</button
          ><button
            class:danger={['delete', 'alias-delete'].includes(modal)}
            class:primary={!['delete', 'alias-delete'].includes(modal)}
            disabled={busy ||
              (['expiry', 'link-expiry', 'alias'].includes(modal) &&
                (expiryOptionsLoading ||
                  !expiryOptions ||
                  editChoices.length === 0 ||
                  (modal === 'alias' &&
                    !creationOptions?.deliveryDomains.length)))}
            >{busy
              ? 'Working…'
              : modal === 'alias'
                ? 'Create link'
                : ['expiry', 'link-expiry'].includes(modal)
                  ? 'Save expiry'
                  : 'Confirm'}</button
          >
        </div>
      </form>{/if}
  </Modal>{/if}
