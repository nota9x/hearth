<script lang="ts">
  import { auditSortOptions } from '@hearth/core/audit-search';
  import Clock from '@lucide/svelte/icons/clock';
  import type { Snippet } from 'svelte';

  import { fadeMotion } from '$lib/motion';

  import type { PageData } from '../routes/[...path]/$types';
  import type { AdminActions } from './admin-types';
  import AdminDialogs from './AdminDialogs.svelte';
  import AuditEntry from './AuditEntry.svelte';
  import CollectionEmpty from './CollectionEmpty.svelte';
  import CollectionHeader from './CollectionHeader.svelte';
  import Pagination from './Pagination.svelte';
  import SearchControls from './SearchControls.svelte';
  import StorageManagement from './StorageManagement.svelte';
  import UserManagement from './UserManagement.svelte';

  /* eslint-disable prefer-const -- Bindable Svelte props must be mutable. */
  let {
    data,
    busy = $bindable(false),
    modal = $bindable(''),
    run,
    manualRefresh,
    gallery,
  }: AdminActions & {
    data: PageData;
    busy?: boolean;
    modal?: string;
    gallery: Snippet;
  } = $props();
  /* eslint-enable prefer-const */
  let dialogs = $state<{ open: (name: string, id?: string) => void }>();
  function open(name: string, id = '') {
    dialogs?.open(name, id);
  }
</script>

<AdminDialogs bind:this={dialogs} bind:busy bind:modal {data} />

{#if data.section === 'users'}
  {#key data.member?.user.id}
    <UserManagement
      result={data.userListing}
      member={data.member}
      imagePage={data.memberImages}
      activity={data.memberActivity}
      imagesError={data.memberImagesError}
      activityError={data.memberActivityError}
      instancePolicy={data.instanceExpiryPolicy}
      {busy}
      refresh={manualRefresh}
      invite={() => {
        open('invite');
      }}
      reset={(id: string) => open('user-reset', id)}
      remove={(id: string) => open('user-delete', id)}
      save={run}
    >
      {#snippet images()}{@render gallery()}{/snippet}
    </UserManagement>
  {/key}
{:else if data.section === 'storage'}
  <StorageManagement
    {data}
    {busy}
    {run}
    {manualRefresh}
    resolve={(id: string) => open('finding', id)}
    resolveAll={() => open('findings')}
  />
{:else if data.section === 'audit-log'}
  <CollectionHeader title="Audit log" refresh={manualRefresh} {busy} />
  {#if data.scopedUser}<p in:fadeMotion={{ kind: 'content' }}>
      Actor: <a class="subtle-link" href={`/admin/users/${data.scopedUser.id}`}
        >{data.scopedUser.displayName}</a
      >
    </p>{/if}
  <SearchControls
    total={data.auditTotal}
    unfilteredTotal={data.auditUnfilteredTotal}
    noun="audit event"
    plural="audit events"
    dateLabel="Event date"
    sortOptions={auditSortOptions}
    filters={[
      { key: 'actorId', label: 'Actor user ID', placeholder: 'User ID' },
      {
        key: 'actor',
        label: 'Actor / user',
        placeholder: 'Display name or user ID',
      },
      {
        key: 'action',
        label: 'Action',
        placeholder: 'All actions',
        options: data.auditActions,
      },
      {
        key: 'target',
        label: 'Affected resource',
        placeholder: 'Name, value, or resource ID',
      },
    ]}
  />
  <div class="rows">
    {#each data.logs as log (log.id)}<AuditEntry {log} />{:else}<CollectionEmpty
        title={data.auditUnfilteredTotal
          ? 'No audit events match your search'
          : 'No audit events yet'}
        message={data.auditUnfilteredTotal
          ? 'Try another search or clear your filters.'
          : 'Administrative events will be recorded here.'}
        >{#snippet icon()}<Clock size={30} />{/snippet}
        {#if data.auditUnfilteredTotal}<a class="button" href="/admin/audit-log"
            >Clear search and filters</a
          >{/if}
      </CollectionEmpty>{/each}
  </div>
  {#if data.auditPagination}<Pagination
      current={data.auditPagination.page}
      pages={data.auditPagination.pages}
      total={data.auditTotal}
      size={50}
    />{/if}
{/if}
