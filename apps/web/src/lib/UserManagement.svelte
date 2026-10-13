<script lang="ts">
  import type { PresentedAudit } from '@hearth/core/audit-collection';
  import { bytes, date } from '@hearth/core/common';
  import {
    type ExpiryPolicy,
    type ExpiryPolicyOverrides,
    formatLifetime,
    resolveExpiryPolicy,
  } from '@hearth/core/expiry-policy';
  import type { imageCollection } from '@hearth/core/image-collection';
  import type { userDetails, userPage } from '@hearth/core/user-management';
  import {
    userFilterKeys,
    userRoles,
    userSortOptions,
    userStatuses,
    usersURL,
  } from '@hearth/core/user-search';
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import Clock from '@lucide/svelte/icons/clock';
  import HardDrive from '@lucide/svelte/icons/hard-drive';
  import Image from '@lucide/svelte/icons/image';
  import KeyRound from '@lucide/svelte/icons/key-round';
  import Plus from '@lucide/svelte/icons/plus';
  import Shield from '@lucide/svelte/icons/shield';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Users from '@lucide/svelte/icons/users';
  import { type Snippet, untrack } from 'svelte';

  import { fadeMotion } from '#lib/motion.ts';
  import { page } from '$app/state';

  import ActionMenu from './ActionMenu.svelte';
  import AuditEntry from './AuditEntry.svelte';
  import BackLink from './BackLink.svelte';
  import CollectionEmpty from './CollectionEmpty.svelte';
  import CollectionHeader from './CollectionHeader.svelte';
  import Copy from './Copy.svelte';
  import Disclosure from './Disclosure.svelte';
  import LifetimeSelect from './LifetimeSelect.svelte';
  import Pagination from './Pagination.svelte';
  import SearchControls from './SearchControls.svelte';
  import Statistics from './Statistics.svelte';

  const {
    result,
    member,
    imagePage,
    activity,
    imagesError,
    activityError,
    instancePolicy,
    busy,
    refresh,
    invite,
    reset,
    remove,
    save,
    images,
  }: {
    result: Awaited<ReturnType<typeof userPage>> | null;
    member: Awaited<ReturnType<typeof userDetails>>;
    imagePage: Awaited<ReturnType<typeof imageCollection>> | null;
    activity: PresentedAudit[];
    imagesError: string | null;
    activityError: string | null;
    instancePolicy: ExpiryPolicy;
    busy: boolean;
    refresh: () => Promise<void>;
    invite: () => void;
    reset: (id: string) => void;
    remove: (id: string) => void;
    save: (name: string, input: Record<string, unknown>) => Promise<unknown>;
    images: Snippet;
  } = $props();
  const deleted = $derived(member?.user.status === 'deleted');
  const draft = $state(
    untrack(() => ({
      memberName: member?.user.displayName ?? '',
      memberStatus: member?.user.status ?? 'active',
      memberQuota:
        member?.user.quotaBytes == null
          ? undefined
          : member.user.quotaBytes / 1_048_576,
      memberPolicyCustom: !!member?.user.expiryPolicy,
      memberRequired:
        member?.user.expiryPolicy?.requireExpiry === undefined
          ? 'inherit'
          : String(member.user.expiryPolicy.requireExpiry),
      memberMaximumCustom:
        member?.user.expiryPolicy?.maxLifetimeSeconds !== undefined,
      memberMaximum: member?.user.expiryPolicy?.maxLifetimeSeconds ?? null,
    })),
  );
  function memberOverrides(): ExpiryPolicyOverrides | null {
    if (!draft.memberPolicyCustom) return null;
    return {
      ...(draft.memberRequired !== 'inherit' && {
        requireExpiry: draft.memberRequired === 'true',
      }),
      ...(draft.memberMaximumCustom && {
        maxLifetimeSeconds: draft.memberMaximum,
      }),
    };
  }
  const memberEffective = $derived(
    resolveExpiryPolicy(instancePolicy, {
      role: member?.user.role ?? 'user',
      expiryPolicy: memberOverrides(),
    }),
  );
  const filtered = $derived(
    !!result?.query ||
      userFilterKeys.some((key) => page.url.searchParams.has(key)),
  );
  const clearURL = $derived(usersURL(new URL('/admin/users', page.url.href)));
  const filters = [
    {
      key: 'status',
      label: 'Account status',
      placeholder: 'Current accounts',
      options: { ...userStatuses, all: 'All accounts' },
    },
    {
      key: 'role',
      label: 'Role',
      placeholder: 'All roles',
      options: userRoles,
    },
  ];
</script>

{#if member}
  <BackLink href={usersURL(new URL(page.url.href))} label="Back to users" />
  <CollectionHeader title={member.user.displayName} {refresh} {busy} />
  <div class="identity" in:fadeMotion|global={{ kind: 'content' }}>
    <span class="badge" data-status={member.user.status}
      >{userStatuses[member.user.status]}</span
    >
    <span class="badge">{userRoles[member.user.role]}</span>
    <code>{member.user.id}</code><Copy
      text={member.user.id}
      label="Copy user ID"
    />
    <span>Joined {date(member.user.createdAt)}</span>
  </div>
  {#if member.user.status !== 'active'}<p
      transition:fadeMotion={{ kind: 'content' }}
      class="notice"
    >
      {deleted
        ? 'This account was deleted. Its images were removed and its retained activity remains available.'
        : 'This account is disabled. Sign-in, uploads, and public links are suspended.'}
    </p>{/if}
  <Statistics
    label="User statistics"
    items={[
      { label: 'Images', value: member.imageCount, icon: Image },
      {
        label: 'Storage used',
        value: bytes(member.bytes),
        icon: HardDrive,
      },
      {
        label: 'Storage quota',
        value:
          member.user.quotaBytes === null
            ? 'Unlimited'
            : bytes(member.user.quotaBytes),
        icon: HardDrive,
      },
      {
        label: 'Last API use',
        value: date(member.keyLastUsed),
        icon: Clock,
      },
    ]}
  />
  <section aria-label="User images">
    <div class="section-heading">
      <h2>Images</h2>
      <a href={`/admin/images?owner=${member.user.id}`}
        >View all images<ArrowRight size={16} /></a
      >
    </div>
    {#if imagesError}
      <CollectionEmpty title="Images unavailable" message={imagesError}
        >{#snippet icon()}<Image size={32} />{/snippet}<button
          onclick={refresh}
          disabled={busy}>Try again</button
        ></CollectionEmpty
      >
    {:else if imagePage?.images.length}
      {@render images()}
      <Pagination
        current={imagePage.pagination.page}
        pages={imagePage.pagination.pages}
        total={imagePage.pagination.total}
        size={imagePage.pagination.size}
        parameter="imagePage"
      />
    {:else}
      <CollectionEmpty
        title="No images owned by this user"
        message={deleted
          ? 'Images belonging to this deleted account have been removed.'
          : 'This user has no saved images.'}
        >{#snippet icon()}<Image size={32} />{/snippet}</CollectionEmpty
      >
    {/if}
  </section>
  <section aria-label="User audit activity">
    <div class="section-heading">
      <h2>Recent activity</h2>
      <a href={`/admin/audit-log?actorId=${member.user.id}`}
        >View all audit events<ArrowRight size={16} /></a
      >
    </div>
    <p class="muted">
      Latest actions performed by this user within retained audit history.
    </p>
    {#if activityError}
      <CollectionEmpty title="Activity unavailable" message={activityError}
        >{#snippet icon()}<Shield size={32} />{/snippet}<button
          onclick={refresh}
          disabled={busy}>Try again</button
        ></CollectionEmpty
      >
    {:else if activity.length}<div class="rows">
        {#each activity as log (log.id)}<AuditEntry {log} />{/each}
      </div>
    {:else}<CollectionEmpty
        title="No retained activity"
        message="There are no retained audit events performed by this user."
        >{#snippet icon()}<Shield size={32} />{/snippet}</CollectionEmpty
      >{/if}
  </section>
  <Disclosure
    title="Account configuration"
    description="Manage identity, account access, and storage allowance."
    icon={Users}
  >
    <fieldset disabled={busy || deleted}>
      <form
        class="settings-form"
        onsubmit={async (event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          await save('user-update', {
            userId: member.user.id,
            displayName: form.get('displayName'),
            status: form.get('status'),
            quotaBytes:
              form.get('quota') === ''
                ? null
                : Number(form.get('quota')) * 1_048_576,
          });
        }}
      >
        <label
          >Display name<input
            name="displayName"
            bind:value={draft.memberName}
            required
            maxlength="80"
          /></label
        >
        <label
          >Account status<select name="status" bind:value={draft.memberStatus}
            ><option value="active">Active</option><option value="disabled"
              >Disabled — public links suspended</option
            >{#if deleted}<option value="deleted">Deleted</option>{/if}</select
          ></label
        >
        <label class="full-width"
          >Storage quota (MiB; blank means unlimited)<input
            type="number"
            min="0"
            name="quota"
            bind:value={draft.memberQuota}
          /></label
        >
        <div class="form-actions">
          <button class="primary" disabled={busy || deleted}>Save user</button>
        </div>
      </form>
    </fieldset>
  </Disclosure>
  <Disclosure
    title="Expiry policy"
    description="Choose inherited defaults or account-specific lifetime limits."
    icon={Clock}
  >
    <fieldset disabled={busy || deleted}>
      <form
        class="settings-form"
        onsubmit={async (event) => {
          event.preventDefault();
          await save('user-expiry-policy', {
            userId: member.user.id,
            policy: memberOverrides(),
          });
        }}
      >
        <label
          >Expiry policy<select bind:value={draft.memberPolicyCustom}
            ><option value={false}>Use instance defaults</option><option
              value={true}>Custom overrides</option
            ></select
          ></label
        >
        {#if draft.memberPolicyCustom}
          <label in:fadeMotion={{ kind: 'content' }}
            >Expiry requirement<select bind:value={draft.memberRequired}
              ><option value="inherit">Use instance default</option><option
                value="true">Required</option
              ><option value="false">Optional</option></select
            ></label
          >
          <label in:fadeMotion={{ kind: 'content' }}
            >Maximum lifetime policy<select
              bind:value={draft.memberMaximumCustom}
              ><option value={false}>Use instance default</option><option
                value={true}>Override maximum lifetime</option
              ></select
            ></label
          >
          {#if draft.memberMaximumCustom}<LifetimeSelect
              bind:value={draft.memberMaximum}
            />{/if}
        {/if}
        <p class="policy-summary full-width">
          Policy source: {memberEffective.source === 'administrator'
            ? 'Administrator exemption'
            : memberEffective.source === 'custom'
              ? 'Custom'
              : 'Instance default'}<br />Expiry required: {memberEffective.requireExpiry ||
          memberEffective.maxLifetimeSeconds !== null
            ? 'Yes'
            : 'No'}<br />Maximum lifetime: {formatLifetime(
            memberEffective.maxLifetimeSeconds,
          )}
        </p>
        <small class="full-width"
          >Existing images, links, and saved defaults remain unchanged. Image
          lifetime begins at upload; link lifetime begins at link creation. If
          the saved default becomes incompatible, uploads fail until the user
          updates it.</small
        >
        <div class="form-actions">
          <button class="primary" disabled={busy || deleted}
            >Save user expiry policy</button
          >
        </div>
      </form>
    </fieldset>
  </Disclosure>
  <section class="panel administrative-actions">
    <h2><Shield size={19} aria-hidden="true" />Administrative actions</h2>
    <p>
      Resetting credentials revokes existing sessions. Deleting an account
      removes its images and public links.
    </p>
    <div class="toolbar">
      <button
        disabled={busy || member.user.status !== 'active'}
        onclick={() => reset(member.user.id)}
        ><KeyRound size={16} />Reset credential</button
      ><button
        class="danger"
        disabled={busy || deleted}
        onclick={() => remove(member.user.id)}
        ><Trash2 size={16} />Delete user</button
      >
    </div>
  </section>
{:else if result}
  <CollectionHeader title="Users" {refresh} {busy}
    ><button class="primary" disabled={busy} onclick={invite}
      ><Plus size={17} />Invite someone</button
    ></CollectionHeader
  >
  <SearchControls
    total={result.pagination.total}
    unfilteredTotal={result.unfilteredTotal}
    noun="user"
    plural="users"
    dateLabel="Joined date"
    {filters}
    sortOptions={userSortOptions}
  />
  <p class="muted account-scope">
    {page.url.searchParams.get('status') === 'all'
      ? 'Showing all accounts, including deleted users.'
      : page.url.searchParams.get('status')
        ? `Showing ${userStatuses[page.url.searchParams.get('status') as keyof typeof userStatuses] ?? 'current'} accounts.`
        : 'Showing active and disabled accounts.'}
  </p>
  {#if result.members.length}
    <div class="table-wrap user-table">
      <table>
        <thead
          ><tr
            ><th>Person</th><th>Role</th><th>Images</th><th>Storage</th><th
              >Joined</th
            ><th><span class="sr-only">Actions</span></th></tr
          ></thead
        ><tbody>
          {#each result.members as row (row.user.id)}<tr>
              <td class="person"
                ><span class="person-identity"
                  ><a href={usersURL(new URL(page.url.href), row.user.id)}
                    ><strong>{row.user.displayName}</strong></a
                  ><span class="badge" data-status={row.user.status}
                    >{userStatuses[row.user.status]}</span
                  ></span
                ></td
              >
              <td data-label="Role">{userRoles[row.user.role]}</td><td
                data-label="Images">{row.imageCount}</td
              ><td data-label="Storage">{bytes(row.bytes)}</td><td
                data-label="Joined">{date(row.user.createdAt)}</td
              >
              <td class="user-actions"
                ><ActionMenu
                  label={`Actions for ${row.user.displayName}`}
                  title="User actions"
                  >{#snippet children(closeMenu: () => void)}<a
                      href={usersURL(new URL(page.url.href), row.user.id)}
                      onclick={closeMenu}><Users size={16} />View user</a
                    ><a
                      href={`/admin/images?owner=${row.user.id}`}
                      onclick={closeMenu}><Image size={16} />View images</a
                    ><a
                      href={`/admin/audit-log?actorId=${row.user.id}`}
                      onclick={closeMenu}
                      ><Shield size={16} />View audit activity</a
                    >{/snippet}</ActionMenu
                ></td
              >
            </tr>{/each}
        </tbody>
      </table>
    </div>
    <Pagination
      current={result.pagination.page}
      pages={result.pagination.pages}
      total={result.pagination.total}
      size={result.pagination.size}
    />
  {:else}
    <CollectionEmpty
      title={result.unfilteredTotal
        ? filtered
          ? result.query
            ? 'No users match your search'
            : 'No users match your filters'
          : 'No current accounts'
        : 'No users yet'}
      message={result.unfilteredTotal
        ? filtered
          ? 'Try another search or clear your filters.'
          : 'Use the status filter to inspect deleted accounts.'
        : 'Invite someone to create an account.'}
      >{#snippet icon()}<Users size={32} />{/snippet}
      {#if filtered}<a class="button" href={clearURL}
          >Clear search and filters</a
        >{:else if result.unfilteredTotal}<a
          class="button"
          href="/admin/users?status=all">View all accounts</a
        >{:else}<button class="primary" onclick={invite}>Invite someone</button
        >{/if}
    </CollectionEmpty>
  {/if}
{/if}

<style>
  .identity {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
    margin: -0.5rem 0 1.5rem;
    color: var(--muted);
    font-size: 0.85rem;
  }
  .identity code {
    overflow-wrap: anywhere;
  }
  .badge[data-status='active'] {
    color: #add1af;
  }
  .badge[data-status='disabled'],
  .badge[data-status='deleted'] {
    color: #efbba8;
  }
  section {
    margin-bottom: 2rem;
  }
  .muted {
    color: var(--muted);
    font-size: 0.85rem;
  }
  .account-scope {
    margin-top: -0.5rem;
  }
  .settings-form {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 20px;
    max-width: 900px;
  }
  .full-width,
  .form-actions {
    grid-column: 1 / -1;
  }
  .form-actions {
    border-top: 1px solid var(--border);
    padding-top: 20px;
  }
  .policy-summary {
    margin: 0;
    padding: 16px 18px;
    border-left: 3px solid var(--accent);
    border-radius: 0 8px 8px 0;
    background: #c4714a0a;
    font-size: 0.85rem;
  }
  fieldset {
    border: 0;
    padding: 0;
    margin: 0;
    min-width: 0;
  }
  .administrative-actions {
    margin-top: 2rem;
  }
  .administrative-actions h2 {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .administrative-actions h2 :global(svg) {
    color: var(--accent);
    flex-shrink: 0;
  }
  .administrative-actions .toolbar {
    margin-bottom: 0;
  }
  .administrative-actions p {
    color: var(--muted);
  }
  .user-table {
    overflow: visible;
  }
  table {
    table-layout: fixed;
    border-collapse: separate;
    border-spacing: 0;
  }
  th:first-child {
    width: 30%;
    border-top-left-radius: 16px;
  }
  th:last-child {
    width: 64px;
    border-top-right-radius: 16px;
  }
  td {
    overflow-wrap: anywhere;
  }
  .person-identity {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.6rem;
  }
  .person a {
    font-size: 0.95rem;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  @media (max-width: 767px) {
    table,
    tbody {
      display: block;
    }
    thead {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
    tr {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      position: relative;
      padding: 1rem;
      border-top: 1px solid var(--border);
      gap: 0.75rem;
    }
    tr:first-child {
      border-top: 0;
    }
    td {
      padding: 0;
      border: 0;
    }
    .person {
      grid-column: 1 / -1;
      padding-right: 2.5rem;
    }
    td[data-label]::before {
      content: attr(data-label);
      display: block;
      font-size: 0.75rem;
      color: var(--muted);
      margin-bottom: 0.25rem;
    }
    .user-actions {
      position: absolute;
      right: 1rem;
      top: 1rem;
    }
  }
  @media (max-width: 600px) {
    .settings-form {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
