<script lang="ts">
  import { dateTime } from '@hearth/core/common';
  import type {
    DeliveryDomain,
    deliveryDomainPage,
    DeliverySelection,
  } from '@hearth/core/delivery-domains';
  import {
    accessModeLabels,
    domainStatusLabels,
  } from '@hearth/core/domain-format';
  import Check from '@lucide/svelte/icons/check';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import Globe from '@lucide/svelte/icons/globe';
  import Star from '@lucide/svelte/icons/star';
  import { untrack } from 'svelte';

  import { goto } from '$app/navigation';
  import { navigating, page } from '$app/state';
  import { fadeMotion } from '$lib/motion';

  import ActionMenu from './ActionMenu.svelte';
  import { action } from './client';
  import CollectionEmpty from './CollectionEmpty.svelte';
  import CollectionHeader from './CollectionHeader.svelte';
  import Copy from './Copy.svelte';
  import { dashboard } from './dashboard';
  import { notify } from './notifications';
  import Pagination from './Pagination.svelte';
  import SearchControls from './SearchControls.svelte';

  const {
    result,
    preferenceId,
    selection,
    available,
  }: {
    result: Awaited<ReturnType<typeof deliveryDomainPage>>;
    preferenceId: string | null;
    selection: DeliverySelection;
    available: DeliveryDomain[];
  } = $props();
  let busy = $state(false);
  const filters = [
    {
      key: 'status',
      label: 'Status',
      placeholder: 'All statuses',
      options: domainStatusLabels,
    },
    {
      key: 'access',
      label: 'Access',
      placeholder: 'All access',
      options: accessModeLabels,
    },
    {
      key: 'role',
      label: 'Role',
      placeholder: 'All roles',
      options: {
        primary: 'Instance default',
        additional: 'Additional delivery',
      },
    },
  ];
  const filtered = $derived(
    ['q', 'status', 'access', 'role', 'date', 'from', 'to'].some((key) =>
      page.url.searchParams.has(key),
    ),
  );
  $effect(() => {
    const requested = Number(page.url.searchParams.get('page') || 1);
    if (navigating.to || requested <= result.pagination.pages) return;
    const url = new URL(page.url);
    if (result.pagination.page === 1) url.searchParams.delete('page');
    else url.searchParams.set('page', String(result.pagination.page));
    untrack(
      () =>
        void goto(url, {
          replaceState: true,
          keepFocus: true,
          noScroll: true,
        }),
    );
  });
  async function refresh() {
    try {
      await dashboard.refresh(true);
      notify.success('Domains refreshed.');
    } catch {
      notify.error('Could not refresh domains.');
    }
  }
  async function preference(domainId: string | null) {
    busy = true;
    try {
      await action('delivery-preference', { deliveryDomainId: domainId });
      notify.success(
        domainId
          ? 'Your delivery selection updated.'
          : 'Following the instance default.',
      );
      await dashboard.refresh(true);
    } catch (error_) {
      notify.error(
        error_ instanceof Error
          ? error_.message
          : 'Could not update delivery selection.',
      );
    } finally {
      busy = false;
    }
  }
</script>

<CollectionHeader title="Domains" {refresh} {busy}></CollectionHeader>
<div class="preference-panel">
  <div>
    <strong>Your delivery preference</strong>
    <p>
      {selection.domain
        ? preferenceId
          ? `Your selection: ${selection.domain.hostname}`
          : `Using instance default: ${selection.domain.hostname}`
        : preferenceId
          ? 'Your selection is unavailable. No usable delivery domain available.'
          : 'Following instance default. No usable delivery domain available.'}
    </p>
  </div>
  {#if preferenceId}<button
      disabled={busy}
      onclick={() => void preference(null)}>Use instance default</button
    >{/if}
</div>
{#if selection.warning}<div
    transition:fadeMotion={{ kind: 'content' }}
    class="notice domain-warning"
  >
    <CircleAlert size={18} />
    <p>
      {selection.warning} Uploads remain available and will be saved privately.
    </p>
  </div>{/if}
<SearchControls
  total={result.pagination.total}
  unfilteredTotal={result.total}
  noun="domain"
  plural="domains"
  dateLabel="Added date"
  {filters}
  sortOptions={{
    newest: 'Newest first',
    oldest: 'Oldest first',
    name: 'Hostname A–Z',
  }}
/>
<div class="rows domain-list" aria-busy={!!navigating.to || busy}>
  {#each result.domains as domain (domain.id)}
    {@const status = domain.enabled ? domain.health : 'disabled'}
    <article
      class="row domain-row"
      aria-label={`Delivery domain ${domain.hostname}`}
    >
      <span class="domain-icon"><Globe size={23} /></span>
      <div class="row-content">
        <strong>{domain.hostname}</strong>
        <small
          >Delivery domain&nbsp;·&nbsp;{accessModeLabels[
            domain.accessMode
          ]}</small
        >
        <small
          >{domain.lastCheckedAt
            ? `Checked ${dateTime(domain.lastCheckedAt)}`
            : 'Not validated yet'}{#if domain.notes}
            &nbsp;·&nbsp;{domain.notes}{/if}</small
        >
        {#if domain.diagnostics?.outcome !== 'passed' && domain.diagnostics}<small
            class="diagnostic-summary">{domain.diagnostics.message}</small
          >{/if}
      </div>
      <div class="domain-state">
        <span class="badge" data-status={status}
          >{domainStatusLabels[status]}</span
        >{#if domain.isPrimary}<span class="badge"
            ><Star size={11} />Instance default</span
          >{/if}{#if preferenceId === domain.id}<span class="badge"
            >Your selection</span
          >{/if}
      </div>
      <div class="row-actions">
        <Copy text={domain.hostname} label="Copy hostname" disabled={busy} />
        <ActionMenu
          label={`Actions for ${domain.hostname}`}
          title="Domain actions"
        >
          {#snippet children(closeMenu: () => void)}
            {#if available.some((item) => item.id === domain.id) && preferenceId !== domain.id}<button
                disabled={busy}
                onclick={() => {
                  closeMenu();
                  void preference(domain.id);
                }}><Check size={16} />Use for my new links</button
              >{/if}
            {#if preferenceId === domain.id}<button
                disabled={busy}
                onclick={() => {
                  closeMenu();
                  void preference(null);
                }}><Star size={16} />Use instance default</button
              >{/if}
            <Copy
              text={domain.hostname}
              label="Copy hostname"
              showLabel
              disabled={busy}
              oncopy={closeMenu}
            />
          {/snippet}
        </ActionMenu>
      </div>
    </article>
  {:else}
    <CollectionEmpty
      title={filtered ? 'No domains match your search' : 'No delivery domains'}
      message={filtered
        ? 'Try another hostname, status, or access filter.'
        : 'Ask an administrator to configure a delivery domain. You can still upload and save images privately.'}
    >
      {#snippet icon()}<Globe size={30} />{/snippet}
      {#if filtered}<a class="button" href={page.url.pathname}>Clear search</a
        >{/if}
    </CollectionEmpty>
  {/each}
</div>
<Pagination
  current={result.pagination.page}
  pages={result.pagination.pages}
  total={result.pagination.total}
  size={result.pagination.size}
/>

<style>
  small,
  .preference-panel p {
    color: var(--muted);
  }
  .preference-panel p {
    overflow-wrap: anywhere;
    font-size: 0.85rem;
    line-height: 1.5;
    margin: 0.5rem 0 0;
  }
  .domain-row {
    padding: 1rem;
    gap: 1rem;
  }
  .domain-row strong {
    overflow-wrap: anywhere;
  }
  .domain-state {
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
    flex-wrap: wrap;
    max-width: 220px;
  }
  .domain-state .badge {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }
  [data-status='active'] {
    color: var(--success, #74b892);
  }
  [data-status='misconfigured'],
  [data-status='unhealthy'] {
    color: var(--danger);
  }
  [data-status='pending'],
  [data-status='disabled'] {
    color: var(--muted);
  }
  .diagnostic-summary {
    max-width: 65ch;
  }
  .preference-panel {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 1rem;
  }
  .domain-warning {
    display: flex;
    align-items: flex-start;
    gap: 0.7rem;
  }
  .domain-warning p {
    margin: 0;
  }
  @media (max-width: 700px) {
    .domain-row {
      flex-wrap: wrap;
      gap: 0.75rem;
    }
    .domain-icon {
      display: none;
    }
    .domain-row .row-content {
      flex-basis: calc(100% - 80px);
    }
    .domain-state {
      max-width: none;
      order: 3;
      flex-basis: 100%;
      padding-top: 0.25rem;
    }
    .preference-panel {
      align-items: flex-start;
    }
  }
</style>
