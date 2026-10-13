<script lang="ts">
  import {
    parseStorageLimit,
    storageBytes,
    storageLimitInput,
  } from '@hearth/core/storage-view';
  import { untrack } from 'svelte';

  import { saveSettings } from '$lib/settings/settings';
  import SettingsForm from '$lib/settings/SettingsForm.svelte';
  import SettingsRow from '$lib/settings/SettingsRow.svelte';
  import SettingsSection from '$lib/settings/SettingsSection.svelte';
  import SettingsToggle from '$lib/settings/SettingsToggle.svelte';

  import type { PageData } from '../routes/[...path]/$types';

  const { capacity }: { capacity: NonNullable<PageData['storageCapacity']> } =
    $props();
  function defaults() {
    const limit = capacity.limitBytes;
    return {
      enabled: limit !== null,
      ...(limit === null
        ? { amount: '10', unit: 'GB' as const }
        : storageLimitInput(limit)),
    };
  }
  let draft = $state(untrack(defaults));
  let baseline = $state(untrack(() => ({ ...draft })));
  let lastSaveCapacity: typeof capacity | undefined;
  const allocated = $derived(capacity.persistedBytes + capacity.reservedBytes);
  const dirty = $derived(
    draft.enabled !== baseline.enabled ||
      (draft.enabled &&
        (draft.amount !== baseline.amount || draft.unit !== baseline.unit)),
  );
  $effect(() => {
    const next = defaults();
    untrack(() => {
      if (dirty) {
        return;
      }

      draft = next;
      baseline = { ...next };
    });
  });
  const proposed = $derived.by(() => {
    try {
      return draft.enabled ? parseStorageLimit(draft.amount, draft.unit) : null;
    } catch {
      return;
    }
  });
  const validation = $derived.by(() => {
    try {
      if (draft.enabled) parseStorageLimit(draft.amount, draft.unit);
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : 'Enter a valid capacity.';
    }
  });
  function reset() {
    draft = lastSaveCapacity === capacity ? { ...baseline } : defaults();
    baseline = { ...draft };
  }
</script>

<SettingsSection
  title="Global storage limit"
  description="One physical capacity budget for the entire workspace."
>
  <div class="settings-policy">
    <strong
      >{capacity.limitBytes === null
        ? 'No global limit'
        : `${storageBytes(capacity.limitBytes)} global limit`}</strong
    >
    <span>{storageBytes(allocated)} allocated, including reservations</span>
  </div>
  {#if !capacity.ready}<p class="notice settings-message">
      Complete storage initialization and a baseline scan before enabling a
      limit.
      <a href="/admin/storage">View storage health</a>
    </p>{/if}
  <SettingsForm
    {dirty}
    invalid={proposed === undefined || (draft.enabled && !capacity.ready)}
    saveLabel="Save limit"
    {reset}
    save={() =>
      saveSettings('storage-limit', { limitBytes: proposed }, () => {
        baseline = { ...draft };
        lastSaveCapacity = capacity;
      })}
  >
    <SettingsRow
      id="global-limit"
      label="Enable global limit"
      toggle
      description="Account quotas apply independently."
      info="Counts stored originals, previews, temporary files, and reserved capacity across Hearth. Account quotas still apply separately. When capacity is exhausted, new capacity-consuming writes are blocked; existing files and reads are preserved. Disabling the limit keeps accounting and cleanup active."
    >
      <SettingsToggle
        id="global-limit"
        bind:checked={draft.enabled}
        disabled={!capacity.ready && capacity.limitBytes === null}
      />
    </SettingsRow>
    {#if draft.enabled}
      <SettingsRow
        id="storage-capacity"
        label="Capacity"
        description="Use decimal units, with up to six decimal places."
        info="The total physical storage budget, not additional space. You may set a limit below current allocation: files are preserved, but additional capacity-consuming writes are blocked until space is available."
      >
        <input
          id="storage-capacity"
          class="settings-number"
          type="text"
          inputmode="decimal"
          bind:value={draft.amount}
          aria-invalid={validation !== ''}
          aria-describedby="capacity-error"
          required
        />
      </SettingsRow>
      <SettingsRow
        id="storage-unit"
        label="Unit"
        info="Decimal units: 1 MB is 1,000,000 bytes, 1 GB is 1,000 MB, and 1 TB is 1,000 GB. Hearth stores the limit as an exact number of bytes."
      >
        <select id="storage-unit" class="settings-unit" bind:value={draft.unit}>
          <option>MB</option><option>GB</option><option>TB</option>
        </select>
      </SettingsRow>
    {/if}
    <p
      id="capacity-error"
      class:error={!!validation}
      class="settings-message"
      role="status"
    >
      {#if dirty && validation}{validation}
      {:else if dirty && proposed !== undefined}
        {proposed === null
          ? 'Disabling the limit restores unlimited capacity. Tracking and cleanup continue.'
          : proposed < allocated
            ? 'This limit is below allocated storage. Existing files are preserved; additional capacity-consuming writes will be blocked.'
            : `${storageBytes(proposed - allocated)} would be available with this limit.`}
      {/if}
    </p>
  </SettingsForm>
</SettingsSection>
