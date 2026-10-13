<script lang="ts">
  import { durations } from '@hearth/core/common';
  import { formatLifetime } from '@hearth/core/expiry-policy';
  import { type Snippet, untrack } from 'svelte';

  import { fadeMotion } from '$lib/motion';

  /* eslint-disable prefer-const -- Bindable props share one Svelte declaration. */
  let {
    value = $bindable(null),
    invalid = $bindable(false),
    field,
  }: {
    value: number | null;
    invalid?: boolean;
    field?: Snippet<[string, string, Snippet]>;
  } = $props();
  /* eslint-enable prefer-const */
  const id = $props.id();
  function option(seconds: number | null) {
    return seconds === null
      ? 'unlimited'
      : Object.values(durations).includes(seconds)
        ? String(seconds)
        : 'custom';
  }
  let mode = $state(untrack(() => option(value)));
  let amount = $state<number | undefined>(untrack(() => value ?? 1));
  let unit = $state(1);
  $effect(() => {
    const next = value;
    untrack(() => {
      if (mode === 'custom' && next === (amount ?? 0) * unit) return;
      mode = option(next);
      amount = next ?? 1;
      unit = 1;
    });
  });
  $effect(() => {
    invalid =
      mode === 'custom' &&
      (amount === undefined ||
        amount <= 0 ||
        !Number.isSafeInteger(amount) ||
        !Number.isSafeInteger(amount * unit) ||
        amount * unit > 8_640_000_000_000);
  });
  function update() {
    if (
      amount !== undefined &&
      amount > 0 &&
      Number.isSafeInteger(amount * unit)
    )
      value = amount * unit;
  }
</script>

{#snippet maximum()}
  <select
    id={`${id}-maximum`}
    bind:value={mode}
    onchange={(event) => {
      mode = event.currentTarget.value;
      if (mode === 'unlimited') value = null;
      else if (mode === 'custom') {
        amount = value ?? 1;
        unit = 1;
        update();
      } else value = Number(mode);
    }}
  >
    <option value="unlimited">Unlimited</option>
    {#each Object.values(durations) as seconds (seconds)}
      <option value={String(seconds)}>{formatLifetime(seconds)}</option>
    {/each}
    <option value="custom">Custom duration</option>
  </select>
{/snippet}
{#snippet duration()}
  <input
    id={`${id}-duration`}
    class="settings-number"
    type="number"
    min="1"
    max={Math.floor(8_640_000_000_000 / unit)}
    step="1"
    required
    bind:value={amount}
    oninput={(event) => {
      amount =
        event.currentTarget.value === ''
          ? undefined
          : event.currentTarget.valueAsNumber;
      update();
    }}
    aria-invalid={invalid}
  />
{/snippet}
{#snippet units()}
  <select
    id={`${id}-unit`}
    class="settings-unit"
    bind:value={unit}
    onchange={(event) => {
      unit = Number(event.currentTarget.value);
      update();
    }}
  >
    <option value={1}>Seconds</option><option value={60}>Minutes</option>
    <option value={3600}>Hours</option><option value={86_400}>Days</option>
  </select>
{/snippet}
{#if field}
  {@render field('Maximum lifetime', `${id}-maximum`, maximum)}
  {#if mode === 'custom'}
    {@render field('Duration', `${id}-duration`, duration)}
    {@render field('Duration unit', `${id}-unit`, units)}
  {/if}
{:else}
  <label>Maximum lifetime{@render maximum()}</label>
  {#if mode === 'custom'}
    <label in:fadeMotion={{ kind: 'content' }}
      >Duration{@render duration()}</label
    >
    <label in:fadeMotion={{ kind: 'content' }}
      >Duration unit{@render units()}</label
    >
  {/if}
{/if}
