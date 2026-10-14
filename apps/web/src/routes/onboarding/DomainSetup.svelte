<script lang="ts">
  import type { DeliveryDomain } from '@hearth/core/delivery-domains';
  import { domainStatusLabels } from '@hearth/core/domain-format';
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import Check from '@lucide/svelte/icons/check';
  import Globe from '@lucide/svelte/icons/globe';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';

  import { action, ActionError } from '#lib/client.ts';
  import DomainConnection from '#lib/DomainConnection.svelte';
  import Spinner from '#lib/Spinner.svelte';

  /* eslint-disable prefer-const -- Bindable state and reactive inputs use one Svelte props declaration. */
  let {
    domains,
    busy = $bindable(false),
    domain = $bindable(null),
    hostname = $bindable(''),
    refresh,
    onExpired,
  }: {
    domains: DeliveryDomain[];
    busy?: boolean;
    domain: DeliveryDomain | null;
    hostname: string;
    refresh: () => Promise<void>;
    onExpired: () => void;
  } = $props();
  /* eslint-enable prefer-const */
  let error = $state('');
  async function run(name: string, input: Record<string, unknown>) {
    if (busy) return;
    busy = true;
    error = '';
    try {
      if (name === 'delivery-domain-primary') {
        await action(name, input);
        domain = await action<DeliveryDomain>('delivery-domain-details', {
          id: domain!.id,
        });
      } else domain = await action<DeliveryDomain>(name, input);
      await refresh();
    } catch (error_) {
      error =
        error_ instanceof Error
          ? error_.message
          : 'Could not save. Please try again.';
      if (error_ instanceof ActionError && error_.status === 401) onExpired();
    } finally {
      busy = false;
    }
  }
</script>

<div class="domain-setup">
  {#if domains.length > 0}
    <label
      >Configured domains<select
        value={domain?.id ?? ''}
        disabled={busy}
        onchange={(event) => {
          const value = event.currentTarget.value;
          domain = domains.find((item) => item.id === value) ?? null;
          error = '';
        }}
        ><option value="">Add another domain</option
        >{#each domains as item (item.id)}<option value={item.id}
            >{item.hostname} · {domainStatusLabels[
              item.enabled ? item.health : 'disabled'
            ]}</option
          >{/each}</select
      ></label
    >
  {/if}
  {#if !domain}
    <form
      onsubmit={(event) => {
        event.preventDefault();
        void run('delivery-domain-save', { hostname, accessMode: 'everyone' });
      }}
    >
      <label
        >Delivery hostname<input
          bind:value={hostname}
          disabled={busy}
          placeholder="images.example.com"
          required
          autocomplete="off"
          spellcheck="false"
          aria-describedby={error
            ? 'hostname-help domain-error'
            : 'hostname-help'}
          aria-invalid={!!error}
        /></label
      >
      <p id="hostname-help">
        Use the full hostname where you’ll share images. You’ll connect it to
        your delivery Worker next.
      </p>
      <button class="primary" disabled={busy}
        >{#if busy}<Spinner size={18} />{:else}<Globe size={18} />{/if}Add
        delivery domain</button
      >
    </form>
  {:else}
    <div class="domain-heading">
      <Globe size={22} />
      <div>
        <strong>{domain.hostname}</strong><small
          >{domainStatusLabels[
            domain.enabled ? domain.health : 'disabled'
          ]}{#if domain.isPrimary}
            · Instance default{/if}</small
        >
      </div>
    </div>
    {#if domain.isPrimary && domain.enabled && domain.health === 'active'}
      <p class="ready">
        <Check size={18} />Your delivery domain is ready for new share links.
      </p>
    {:else}
      <DomainConnection {domain} />
      <div class="domain-actions">
        <button
          disabled={busy || !domain.enabled}
          onclick={() =>
            void run('delivery-domain-validate', { id: domain!.id })}
          >{#if busy}<Spinner size={16} />{:else}<RefreshCw
              size={16}
            />{/if}Validate domain</button
        >
        {#if domain.enabled && domain.health === 'active'}<button
            class="primary"
            disabled={busy}
            onclick={() =>
              void run('delivery-domain-primary', {
                id: domain!.id,
                revision: domain!.revision,
              })}>Set as instance default</button
          >{/if}
      </div>
      {#if !domain.enabled}<p>
          Delivery is disabled for this domain. You can manage it later in
          Administration <ArrowRight size={14} aria-hidden="true" /> Domains.
        </p>{/if}
    {/if}
  {/if}
  {#if error}<p id="domain-error" class="error" role="alert">{error}</p>{/if}
</div>

<style>
  p :global(svg) {
    display: inline-block;
    vertical-align: -0.15em;
  }
  .domain-setup,
  form {
    display: grid;
    gap: 20px;
  }
  p {
    font-size: 0.85rem;
    margin: 0;
  }
  button {
    justify-self: start;
  }
  .domain-heading {
    display: flex;
    align-items: center;
    gap: 12px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border);
    color: #e6b38e;
  }
  strong {
    overflow-wrap: anywhere;
  }
  small {
    display: block;
    color: var(--muted);
  }
  .domain-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }
  .ready {
    display: flex;
    align-items: center;
    gap: 10px;
    color: #b8bf96;
  }
</style>
