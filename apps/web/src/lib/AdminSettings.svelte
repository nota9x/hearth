<script lang="ts">
  import { formatLifetime } from '@hearth/core/expiry-policy';
  import { type Snippet, untrack } from 'svelte';

  import GlobalStorageLimit from '#lib/GlobalStorageLimit.svelte';
  import LifetimeSelect from '#lib/LifetimeSelect.svelte';
  import { saveSettings } from '#lib/settings/settings.ts';
  import SettingsForm from '#lib/settings/SettingsForm.svelte';
  import SettingsRow from '#lib/settings/SettingsRow.svelte';
  import SettingsSection from '#lib/settings/SettingsSection.svelte';
  import SettingsToggle from '#lib/settings/SettingsToggle.svelte';

  import type { PageData } from '../routes/[...path]/$types';

  const { data }: { data: PageData } = $props();
  let name = $state(untrack(() => data.siteName));
  let savedName = $state(untrack(() => name));
  let length = $state<number | undefined>(
    untrack(() => data.shareSlugConfiguration!.defaultLength),
  );
  let savedLength = $state(untrack(() => length));
  let policy = $state(untrack(() => ({ ...data.instanceExpiryPolicy })));
  let savedPolicy = $state(untrack(() => ({ ...policy })));
  let invalidLifetime = $state(false);
  let lifetimeRevision = $state(0);
  let lastNameSave: PageData | undefined;
  let lastLengthSave: PageData | undefined;
  let lastPolicySave: PageData | undefined;
  const policyDirty = $derived(
    policy.requireExpiry !== savedPolicy.requireExpiry ||
      policy.maxLifetimeSeconds !== savedPolicy.maxLifetimeSeconds ||
      invalidLifetime,
  );
  $effect(() => {
    const nextName = data.siteName;
    const nextLength = data.shareSlugConfiguration!.defaultLength;
    const nextPolicy = data.instanceExpiryPolicy;
    untrack(() => {
      if (name === savedName) name = savedName = nextName;
      if (length === savedLength) length = savedLength = nextLength;
      if (policyDirty) {
        return;
      }

      policy = { ...nextPolicy };
      savedPolicy = { ...nextPolicy };
    });
  });
  function resetPolicy() {
    policy = {
      ...(lastPolicySave === data ? savedPolicy : data.instanceExpiryPolicy),
    };
    savedPolicy = { ...policy };
    invalidLifetime = false;
    lifetimeRevision++;
  }
  const lifetimeHelp: Record<string, string> = {
    'Maximum lifetime':
      'The longest lifetime allowed for member images and links, measured from upload or link creation. Any finite maximum requires expiry, even when the separate expiry switch is off. Account overrides can replace this maximum; administrators are exempt.',
    Duration:
      'Enter a positive whole number. The selected unit determines the maximum lifetime. This does not change existing image or link expiries.',
    'Duration unit':
      'Choose seconds, minutes, hours, or days for the custom maximum lifetime.',
  };
</script>

<SettingsSection
  title="Workspace name"
  description="The name shown throughout Hearth."
>
  <SettingsForm
    dirty={name !== savedName}
    saveLabel="Save name"
    reset={() =>
      (name = savedName = lastNameSave === data ? savedName : data.siteName)}
    save={() =>
      saveSettings('settings', { siteName: name }, () => {
        name = savedName = name.trim();
        lastNameSave = data;
      })}
  >
    <SettingsRow
      id="workspace-name"
      label="Name"
      description="Help members recognize this workspace."
      info="This name appears in the navigation and page titles for everyone. It does not change your domains, account names, or existing share links."
    >
      <input id="workspace-name" bind:value={name} required maxlength="60" />
    </SettingsRow>
  </SettingsForm>
</SettingsSection>

<SettingsSection
  title="Share-link IDs"
  description="Choose the default length of newly generated links."
>
  <SettingsForm
    dirty={length !== savedLength}
    saveLabel="Save slug length"
    reset={() =>
      (length = savedLength =
        lastLengthSave === data
          ? savedLength
          : data.shareSlugConfiguration!.defaultLength)}
    save={() =>
      saveSettings('share-slug-settings', { length }, () => {
        savedLength = length;
        lastLengthSave = data;
      })}
  >
    <SettingsRow
      id="slug-length"
      label="Default share-link slug length"
      description="Between 3 and 64 characters."
      info="Shorter IDs create cleaner URLs but leave fewer possible addresses. Hearth may automatically allocate longer IDs when needed for reliable generation. Lowering this default does not remove that automatic minimum or rename existing links."
    >
      <input
        id="slug-length"
        class="settings-number"
        type="number"
        min="3"
        max="64"
        step="1"
        bind:value={length}
        required
      />
    </SettingsRow>
    <div class="settings-policy">
      <span
        >Configured length: <strong
          >{data.shareSlugConfiguration!.defaultLength} characters</strong
        ></span
      >
      <span
        >Current allocation length: <strong
          >{data.shareSlugConfiguration!.effectiveLength} characters</strong
        ></span
      >
    </div>
    {#if data.shareSlugConfiguration!.automaticFloor > 3}<p
        class="settings-message"
      >
        Hearth automatically increased the allocation minimum to {data
          .shareSlugConfiguration!.automaticFloor} characters. Lowering the default
        will keep this minimum.
      </p>{/if}
  </SettingsForm>
</SettingsSection>

<SettingsSection
  title="Expiry policy"
  description="Workspace defaults for members. Administrators are exempt."
>
  <SettingsForm
    dirty={policyDirty}
    invalid={invalidLifetime}
    saveLabel="Save expiry policy"
    reset={resetPolicy}
    save={() =>
      saveSettings('expiry-policy', { policy: { ...policy } }, () => {
        savedPolicy = { ...policy };
        lastPolicySave = data;
      })}
  >
    <SettingsRow
      id="require-expiry"
      label="Require image and link expiry"
      toggle
      description="Prevent permanent images and links under this default policy."
      info="Members must choose an expiry when this is enabled. Individual account overrides may tighten or relax this requirement. A finite maximum lifetime also requires expiry, independently of this switch."
    >
      <SettingsToggle id="require-expiry" bind:checked={policy.requireExpiry} />
    </SettingsRow>
    {#key lifetimeRevision}<LifetimeSelect
        bind:value={policy.maxLifetimeSeconds}
        bind:invalid={invalidLifetime}
      >
        {#snippet field(label: string, id: string, control: Snippet)}
          <SettingsRow {id} {label} info={lifetimeHelp[label]}>
            {@render control()}
          </SettingsRow>
        {/snippet}
      </LifetimeSelect>{/key}
    <div class="settings-policy" role="status">
      <strong
        >{policy.maxLifetimeSeconds === null
          ? policy.requireExpiry
            ? 'Expiry required · no maximum lifetime'
            : 'Permanent images and links allowed'
          : `Expiry required · maximum ${formatLifetime(policy.maxLifetimeSeconds)}`}</strong
      >
    </div>
    {#if policy.maxLifetimeSeconds !== null && !policy.requireExpiry}<p
        class="settings-message"
      >
        This maximum requires expiry even with the switch off.
      </p>{/if}
    <p class="settings-message">
      Account overrides may tighten or relax these defaults. Changes affect
      future uploads, new links, and expiry edits; existing images, links, and
      saved defaults remain unchanged.
    </p>
  </SettingsForm>
</SettingsSection>

{#if data.storageCapacity}<GlobalStorageLimit
    capacity={data.storageCapacity}
  />{/if}
