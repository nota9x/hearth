<script lang="ts">
  import { dateTime } from '@hearth/core/common';

  import { fadeMotion } from '$lib/motion';

  /* eslint-disable prefer-const -- Bindable Svelte props must be mutable. */
  let {
    value = $bindable('never'),
    customDate = $bindable(''),
    choices,
    label,
    deadline = null,
    loading = false,
    origin = 'upload',
  }: {
    value: string;
    customDate: string;
    choices: [string, string][];
    label: string;
    deadline?: number | null;
    loading?: boolean;
    origin?: string;
  } = $props();
  function localDate(timestamp: number) {
    const date = new Date(timestamp * 1000);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 19);
  }
</script>

<label
  >{label}<select bind:value required disabled={loading}>
    {#each choices as [token, name] (token)}<option value={token}>{name}</option
      >{/each}
  </select></label
>
{#if value === 'custom'}<label in:fadeMotion={{ kind: 'content' }}
    >Expiration date and time<input
      type="datetime-local"
      step="1"
      min={localDate(Math.floor(Date.now() / 1000) + 1)}
      max={deadline === null ? undefined : localDate(deadline)}
      bind:value={customDate}
      required
    /></label
  >{/if}
{#if loading}<small in:fadeMotion={{ kind: 'content' }}
    >Loading valid expiry choices…</small
  >
{:else if deadline !== null}<small in:fadeMotion={{ kind: 'content' }}
    >Latest allowed expiry: {dateTime(deadline)}. The lifetime is measured from
    each {origin}.</small
  >{/if}
{#if !loading && choices.length === 0}<p
    transition:fadeMotion={{ kind: 'content' }}
    class="error"
  >
    No future expiry is allowed for this selection. Refresh or ask an
    administrator to change the policy.
  </p>{/if}
