<script lang="ts">
  import { dateTime } from '@hearth/core/common';
  import type {
    DeliveryDomain,
    deliveryDomainPage,
    DeliverySelection,
    domainDetails,
    domainMembers,
  } from '@hearth/core/delivery-domains';
  import {
    accessModeLabels,
    domainStatusLabels,
  } from '@hearth/core/domain-format';
  import Check from '@lucide/svelte/icons/check';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import Globe from '@lucide/svelte/icons/globe';
  import Info from '@lucide/svelte/icons/info';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Plus from '@lucide/svelte/icons/plus';
  import Power from '@lucide/svelte/icons/power';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Search from '@lucide/svelte/icons/search';
  import Star from '@lucide/svelte/icons/star';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import { onDestroy, untrack } from 'svelte';

  import { goto } from '$app/navigation';
  import { navigating, page } from '$app/state';
  import { fadeMotion } from '$lib/motion';

  import ActionMenu from './ActionMenu.svelte';
  import { action } from './client';
  import CollectionEmpty from './CollectionEmpty.svelte';
  import CollectionHeader from './CollectionHeader.svelte';
  import Copy from './Copy.svelte';
  import { dashboard } from './dashboard';
  import DomainConnection from './DomainConnection.svelte';
  import Modal from './Modal.svelte';
  import { notify } from './notifications';
  import Pagination from './Pagination.svelte';
  import SearchControls from './SearchControls.svelte';
  import SelectAll from './SelectAll.svelte';
  import Spinner from './Spinner.svelte';

  const {
    result,
    admin,
    preferenceId,
    selection,
    available,
  }: {
    result: Awaited<ReturnType<typeof deliveryDomainPage>>;
    admin: boolean;
    preferenceId: string | null;
    selection: DeliverySelection;
    available: DeliveryDomain[];
  } = $props();
  type Details = Awaited<ReturnType<typeof domainDetails>>;
  type MemberPage = Awaited<ReturnType<typeof domainMembers>>;
  let modal = $state<
    'add' | 'edit' | 'details' | 'primary' | 'remove' | 'availability' | ''
  >('');
  let target = $state<Details | null>(null);
  let busy = $state(false),
    loading = $state(false),
    error = $state('');
  let hostname = $state(''),
    notes = $state('');
  let accessMode = $state<DeliveryDomain['accessMode']>('everyone');
  let replacement = $state('');
  let members = $state<MemberPage | null>(null),
    memberQuery = $state(''),
    membersLoading = $state(false);
  let changes = $state<Record<string, boolean>>({});
  let memberRequest = 0,
    detailsRequest = 0;
  let memberTimer: ReturnType<typeof setTimeout> | undefined;
  const memberIds = $derived(
    members?.members
      .filter((member) => member.role !== 'admin')
      .map((member) => member.id) ?? [],
  );
  const selectedMembers = $derived(
    members?.members
      .filter((member) => changes[member.id] ?? member.granted)
      .map((member) => member.id) ?? [],
  );
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
  onDestroy(() => {
    clearTimeout(memberTimer);
    memberRequest++;
    detailsRequest++;
  });
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
  function close() {
    if (busy) return;
    modal = '';
    target = null;
    error = '';
    memberRequest++;
    detailsRequest++;
    clearTimeout(memberTimer);
  }
  async function refresh() {
    try {
      await dashboard.refresh(true);
      notify.success('Domains refreshed.');
    } catch {
      notify.error('Could not refresh domains.');
    }
  }
  async function open(mode: typeof modal, domain?: DeliveryDomain) {
    const request = ++detailsRequest;
    loading = false;
    error = '';
    members = null;
    changes = {};
    memberQuery = '';
    replacement = '';
    target = null;
    hostname = '';
    notes = '';
    accessMode = 'everyone';
    modal = mode;
    if (domain) {
      loading = true;
      try {
        const details = await action<Details>('delivery-domain-details', {
          id: domain.id,
        });
        if (request !== detailsRequest) return;
        target = details;
        hostname = details.hostname;
        notes = details.notes;
        accessMode = details.accessMode;
      } catch (error_) {
        if (request === detailsRequest)
          error =
            error_ instanceof Error
              ? error_.message
              : 'Could not load domain details.';
      } finally {
        if (request === detailsRequest) loading = false;
      }
    }
    if (request === detailsRequest && ['add', 'edit'].includes(mode))
      await loadMembers(1);
  }
  async function loadMembers(number: number) {
    const request = ++memberRequest;
    membersLoading = true;
    try {
      const query = new URLSearchParams({
        q: memberQuery,
        page: String(number),
      }).toString();
      const response = await action<MemberPage>('delivery-domain-members', {
        id: target?.id ?? null,
        query,
      });
      if (request === memberRequest) members = response;
    } catch (error_) {
      if (request === memberRequest)
        error =
          error_ instanceof Error ? error_.message : 'Could not load members.';
    } finally {
      if (request === memberRequest) membersLoading = false;
    }
  }
  function searchMembers() {
    clearTimeout(memberTimer);
    memberTimer = setTimeout(() => void loadMembers(1), 250);
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
  async function validate(domain: DeliveryDomain) {
    busy = true;
    error = '';
    try {
      const details = await action<Details>('delivery-domain-validate', {
        id: domain.id,
      });
      if (target?.id === details.id) target = details;
      if (details.diagnostics?.outcome === 'passed')
        notify.success(`${domain.hostname} passed validation.`);
      else
        notify.warning(
          details.diagnostics?.message || 'Validation needs attention.',
        );
      await dashboard.refresh(true);
    } catch (error_) {
      const message =
        error_ instanceof Error
          ? error_.message
          : 'Validation could not complete.';
      error = message;
      notify.error(message);
    } finally {
      busy = false;
    }
  }
  async function submit() {
    busy = true;
    error = '';
    try {
      if (modal === 'add' || modal === 'edit') {
        const saved = await action<Details>('delivery-domain-save', {
          ...(target && { id: target.id, revision: target.revision }),
          hostname,
          notes,
          accessMode,
          addMembers: Object.keys(changes).filter((id) => changes[id]),
          removeMembers: Object.keys(changes).filter((id) => !changes[id]),
        });
        target = saved;
        modal = 'details';
        notify.success(
          saved.health === 'pending'
            ? 'Delivery domain added. Complete Cloudflare setup and validate it.'
            : 'Domain configuration saved.',
        );
      } else if (target) {
        if (modal === 'primary')
          await action('delivery-domain-primary', {
            id: target.id,
            revision: target.revision,
          });
        else
          await action(
            modal === 'remove'
              ? 'delivery-domain-remove'
              : 'delivery-domain-availability',
            {
              id: target.id,
              revision: target.revision,
              enabled: !target.enabled,
              expectedLinkCount: target.linkCount,
              replacementId:
                replacement && replacement !== 'clear' ? replacement : null,
              clearPrimary: replacement === 'clear',
            },
          );
        notify.success(
          modal === 'primary'
            ? 'Instance default updated. Existing links keep their assigned domain.'
            : modal === 'remove'
              ? 'Domain removed and its share links revoked. Images are still saved.'
              : target.enabled
                ? 'Delivery disabled for this domain.'
                : 'Delivery enabled. Validate it before creating new links.',
        );
        modal = '';
        target = null;
      }
      await dashboard.refresh(true);
    } catch (error_) {
      error =
        error_ instanceof Error
          ? error_.message
          : 'Could not update this domain.';
    } finally {
      busy = false;
    }
  }
</script>

<CollectionHeader title="Domains" {refresh} {busy}>
  {#if admin}<button
      class="primary"
      disabled={busy}
      onclick={() => void open('add')}
      ><Plus size={18} />Add delivery domain</button
    >{/if}
</CollectionHeader>
{#if !admin}<div class="preference-panel">
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
  </div>{/if}
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
          ]}{#if admin}
            &nbsp;·&nbsp;{domain.linkCount} share {domain.linkCount === 1
              ? 'link'
              : 'links'}{/if}</small
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
            {#if admin}
              <button
                disabled={busy}
                onclick={() => {
                  closeMenu();
                  void open('details', domain);
                }}><Info size={16} />Details & diagnostics</button
              >
              <button
                disabled={busy}
                onclick={() => {
                  closeMenu();
                  void open('edit', domain);
                }}><Pencil size={16} />Configure</button
              >
              <button
                disabled={busy}
                onclick={() => {
                  closeMenu();
                  void validate(domain);
                }}
                ><RefreshCw size={16} />{domain.lastCheckedAt
                  ? 'Revalidate'
                  : 'Validate'}</button
              >
              {#if !domain.isPrimary && domain.enabled && domain.health === 'active'}<button
                  disabled={busy}
                  onclick={() => {
                    closeMenu();
                    void open('primary', domain);
                  }}><Star size={16} />Set as instance default</button
                >{/if}
              <button
                disabled={busy}
                onclick={() => {
                  closeMenu();
                  void open('availability', domain);
                }}
                ><Power size={16} />{domain.enabled
                  ? 'Disable delivery'
                  : 'Enable delivery'}</button
              >
            {/if}
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
            {#if admin}<div class="menu-delete">
                <button
                  class="danger"
                  disabled={busy}
                  onclick={() => {
                    closeMenu();
                    void open('remove', domain);
                  }}><Trash2 size={16} />Remove domain</button
                >
              </div>{/if}
          {/snippet}
        </ActionMenu>
      </div>
    </article>
  {:else}
    <CollectionEmpty
      title={filtered ? 'No domains match your search' : 'No delivery domains'}
      message={filtered
        ? 'Try another hostname, status, or access filter.'
        : admin
          ? 'Add a delivery domain, connect it to Cloudflare, and validate it to start sharing images.'
          : 'Ask an administrator to configure a delivery domain. You can still upload and save images privately.'}
    >
      {#snippet icon()}<Globe size={30} />{/snippet}
      {#if filtered}<a class="button" href={page.url.pathname}>Clear search</a
        >{/if}{#if admin && !filtered}<button onclick={() => void open('add')}
          ><Plus size={16} />Add delivery domain</button
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

{#if modal}
  <Modal
    title={modal === 'add'
      ? 'Add delivery domain'
      : modal === 'edit'
        ? 'Configure delivery domain'
        : modal === 'primary'
          ? 'Change instance default'
          : modal === 'remove'
            ? 'Remove delivery domain'
            : modal === 'availability'
              ? target?.enabled
                ? 'Disable delivery'
                : 'Enable delivery'
              : 'Domain details & diagnostics'}
    onClose={close}
    wide={modal === 'details'}
    {busy}
  >
    {#if error}<p
        transition:fadeMotion={{ kind: 'content' }}
        class="error"
        role="alert"
      >
        {error}
      </p>{/if}
    {#if loading}<p in:fadeMotion={{ kind: 'content' }} class="loading">
        <Spinner size={18} />Loading domain details…
      </p>
    {:else if modal === 'details' && target}
      <div class="diagnostics-content" in:fadeMotion={{ kind: 'content' }}>
        <dl class="domain-details">
          <dt>Hostname</dt>
          <dd class="hostname-value">
            {target.hostname}<Copy
              text={target.hostname}
              label="Copy hostname"
            />
          </dd>
          <dt>Type</dt>
          <dd>Delivery domain</dd>
          <dt>Role</dt>
          <dd>
            {target.isPrimary
              ? 'Instance default'
              : 'Additional delivery domain'}
          </dd>
          <dt>Status</dt>
          <dd>
            <span
              class="badge"
              data-status={target.enabled ? target.health : 'disabled'}
              >{domainStatusLabels[
                target.enabled ? target.health : 'disabled'
              ]}</span
            >
          </dd>
          <dt>Access</dt>
          <dd>{accessModeLabels[target.accessMode]}</dd>
          <dt>Share links</dt>
          <dd>{target.linkCount}</dd>
          <dt>Last checked</dt>
          <dd>
            {target.lastCheckedAt ? dateTime(target.lastCheckedAt) : 'Never'}
          </dd>
          <dt>Last healthy</dt>
          <dd>
            {target.lastHealthyAt ? dateTime(target.lastHealthyAt) : 'Never'}
          </dd>
        </dl>
        {#if target.notes}<div class="domain-notes">
            <small>Notes</small>
            <p>{target.notes}</p>
          </div>{/if}
        <DomainConnection domain={target} />
        <div class="toolbar diagnostics-actions">
          <button
            class="primary"
            disabled={busy}
            onclick={() => target && void validate(target)}
            ><RefreshCw size={16} />{busy
              ? 'Checking…'
              : 'Validate domain'}</button
          ><button
            disabled={busy}
            onclick={() => target && void open('edit', target)}
            ><Pencil size={16} />Configure</button
          >
        </div>
      </div>
    {:else if modal === 'add' || modal === 'edit'}
      <form
        class="form-grid"
        onsubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label
          >Hostname<input
            bind:value={hostname}
            required
            maxlength="253"
            placeholder="images.example.com"
            disabled={!!target}
            autocomplete="off"
            spellcheck="false"
          /></label
        >
        <small
          >Use a full hostname. Each subdomain is configured and validated
          separately. Local development also accepts <code>127.0.0.1</code> or
          any
          <code>.localhost</code> subdomain, with the configured delivery port.{#if target}
            To change the hostname, add a new domain and remove this one.{/if}</small
        >
        <label
          >Notes <span class="muted">(optional)</span><textarea
            bind:value={notes}
            maxlength="500"
            rows="2"
            placeholder="What this delivery domain is used for"
          ></textarea></label
        >
        <label
          >Who can create new share links?<select bind:value={accessMode}
            ><option value="everyone">Everyone</option><option
              value="administrators">Administrators only</option
            ><option value="selected">Selected members</option></select
          ></label
        >
        <small
          >Administrators always have access. Changing access affects new
          sharing; existing public links continue to work.</small
        >
        {#if accessMode === 'selected'}<fieldset
            in:fadeMotion={{ kind: 'content' }}
            class="member-picker"
          >
            <legend>Selected members</legend>
            <label class="member-search"
              ><Search size={16} /><input
                aria-label="Search members"
                bind:value={memberQuery}
                oninput={searchMembers}
                placeholder="Search members"
              /></label
            >
            {#if members}<SelectAll
                visible={memberIds}
                selected={selectedMembers}
                disabled={membersLoading}
                label="Select members on this page"
                onchange={(ids: string[]) => {
                  for (const memberId of memberIds)
                    changes[memberId] = ids.includes(memberId);
                }}
              />{/if}
            <div aria-busy={membersLoading}>
              {#each members?.members ?? [] as member (member.id)}<label
                  class="checkbox-label"
                  ><input
                    type="checkbox"
                    checked={member.role === 'admin' ||
                      (changes[member.id] ?? member.granted)}
                    disabled={member.role === 'admin' || membersLoading}
                    onchange={(event) =>
                      (changes[member.id] = event.currentTarget.checked)}
                  />{member.displayName}<small
                    >{member.role === 'admin'
                      ? 'Administrator · always allowed'
                      : member.status === 'disabled'
                        ? 'Disabled account'
                        : 'Member'}</small
                  ></label
                >{:else}<p>
                  {membersLoading
                    ? 'Loading members…'
                    : 'No members match this search.'}
                </p>{/each}
            </div>
            {#if members}<Pagination
                current={members.pagination.page}
                pages={members.pagination.pages}
                total={members.pagination.total}
                size={members.pagination.size}
                busy={membersLoading}
                onchange={(number: number) => void loadMembers(number)}
              />{/if}
            <small>Selections are retained across search and pages.</small>
          </fieldset>{/if}
        <div class="toolbar">
          <button
            class="primary"
            type="submit"
            disabled={busy || membersLoading}
            >{busy
              ? 'Saving…'
              : target
                ? 'Save configuration'
                : 'Add delivery domain'}</button
          ><button type="button" disabled={busy} onclick={close}>Cancel</button>
        </div>
      </form>
    {:else if target}
      <form
        class="form-grid"
        onsubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <strong>{target.hostname}</strong>
        {#if modal === 'primary'}<p>
            Use this domain for newly generated links that follow the instance
            default. Existing links keep their assigned domain.
          </p>
          {#if target.accessMode !== 'everyone'}<div
              in:fadeMotion={{ kind: 'content' }}
              class="notice"
            >
              <p>
                This domain is restricted. Members without access will save new
                uploads privately until they choose an available personal
                delivery domain.
              </p>
            </div>{/if}
        {:else if modal === 'remove'}<p>
            Remove this domain and permanently revoke its {target.linkCount} share
            {target.linkCount === 1 ? 'link' : 'links'}. Images remain saved. {target.preferenceCount}
            personal {target.preferenceCount === 1
              ? 'selection will'
              : 'selections will'} return to following the instance default.
          </p>
          <p>
            After removal, detach the hostname from the delivery Worker in
            Cloudflare and its deployment configuration.
          </p>
        {:else}<p>
            {target.enabled
              ? `Stop serving the ${target.linkCount} share links assigned to this domain. Images and links remain saved; enabling it restores delivery.`
              : 'Resume delivery of existing links on this domain. Validate it before using it for new sharing.'}
          </p>{/if}
        {#if target.isPrimary && modal !== 'primary' && (modal === 'remove' || target.enabled)}<label
            >Instance default after this change<select
              bind:value={replacement}
              required
              ><option value="" disabled
                >Choose a replacement or clear the instance default</option
              >{#each available.filter((domain) => domain.id !== target?.id) as domain (domain.id)}<option
                  value={domain.id}>{domain.hostname}</option
                >{/each}<option value="clear"
                >Clear instance default — uploads following it will save
                privately</option
              ></select
            ></label
          >{/if}
        <div class="toolbar">
          <button
            class:danger={modal === 'remove' ||
              (modal === 'availability' && target.enabled)}
            class:primary={modal === 'primary' ||
              (modal === 'availability' && !target.enabled)}
            type="submit"
            disabled={busy}
            >{busy
              ? 'Saving…'
              : modal === 'remove'
                ? 'Remove domain & revoke links'
                : modal === 'primary'
                  ? 'Set as instance default'
                  : target.enabled
                    ? 'Disable delivery'
                    : 'Enable delivery'}</button
          ><button type="button" disabled={busy} onclick={close}>Cancel</button>
        </div>
      </form>
    {/if}
  </Modal>
{/if}

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
  .domain-details {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 0.7rem 1rem;
    font-size: 0.9rem;
    margin: 0;
    align-items: center;
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .diagnostics-content {
    display: grid;
    gap: 1.25rem;
  }
  .hostname-value {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    justify-content: space-between;
  }
  .domain-notes p {
    margin: 0.25rem 0 0;
    overflow-wrap: anywhere;
    font-size: 0.9rem;
  }
  .diagnostics-actions {
    margin: 0;
    border-top: 1px solid var(--border);
    padding-top: 1rem;
  }
  .loading {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .member-picker {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1rem;
    min-width: 0;
  }
  .member-picker .checkbox-label {
    display: flex;
    gap: 0.6rem;
    align-items: center;
    padding: 0.4rem 0;
  }
  .member-picker small {
    font-size: 0.75rem;
  }
  .member-search {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .member-search input {
    margin: 0;
  }
  .menu-delete {
    border-top: 1px solid var(--border);
    padding-top: 0.4rem;
    margin-top: 0.4rem;
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
