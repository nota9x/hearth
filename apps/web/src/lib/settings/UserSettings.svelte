<script lang="ts">
  import { date } from '@hearth/core/common';
  import {
    defaultExpiryError,
    expiryChoices,
    formatLifetime,
  } from '@hearth/core/expiry-policy';
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
  import Copyright from '@lucide/svelte/icons/copyright';
  import Download from '@lucide/svelte/icons/download';
  import Flame from '@lucide/svelte/icons/flame';
  import Heart from '@lucide/svelte/icons/heart';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Scale from '@lucide/svelte/icons/scale';
  import { type Snippet, untrack } from 'svelte';

  import { action, downloadConfig } from '#lib/client.ts';
  import Copy from '#lib/Copy.svelte';
  import Modal from '#lib/Modal.svelte';
  import ShareXConfig from '#lib/ShareXConfig.svelte';
  import Turnstile from '#lib/Turnstile.svelte';
  import { goto } from '$app/navigation';

  import { version } from '../../../../../package.json';
  import type { PageData } from '../../routes/[...path]/$types';
  import { saveSettings } from './settings';
  import SettingsForm from './SettingsForm.svelte';
  import SettingsPage from './SettingsPage.svelte';
  import SettingsRow from './SettingsRow.svelte';
  import SettingsSection from './SettingsSection.svelte';
  import SettingsToggle from './SettingsToggle.svelte';

  const { data: initialData }: { data: PageData } = $props();
  let data = $derived(initialData);
  function defaults() {
    const duration = /^\d+s$/.test(data.user.defaultExpiry);
    return {
      displayName: data.user.displayName,
      stripImageMetadata: data.user.stripImageMetadata,
      expiry: duration ? 'duration' : data.user.defaultExpiry,
      seconds: duration ? Number(data.user.defaultExpiry.slice(0, -1)) : 3600,
    };
  }
  let draft = $state(untrack(defaults));
  let baseline = $state(untrack(() => ({ ...draft })));
  let lastSaveData: PageData | undefined;
  function expiryValue(form: typeof draft) {
    return form.expiry === 'duration' ? `${form.seconds}s` : form.expiry;
  }
  const dirty = $derived(
    (!data.displayNameRestricted &&
      draft.displayName !== baseline.displayName) ||
      draft.stripImageMetadata !== baseline.stripImageMetadata ||
      expiryValue(draft) !== expiryValue(baseline),
  );
  $effect(() => {
    const next = defaults();
    const restricted = data.displayNameRestricted;
    untrack(() => {
      if (restricted)
        draft.displayName = baseline.displayName = next.displayName;
      if (dirty) {
        return;
      }

      draft = next;
      baseline = { ...next };
    });
  });
  function reset() {
    draft = lastSaveData === data ? { ...baseline } : defaults();
    baseline = { ...draft };
  }
  const policy = $derived(data.expiryPolicy!);
  const choices = $derived(
    expiryChoices(policy).filter(([value]) => value !== 'custom'),
  );
  const savedDefaultError = $derived(
    defaultExpiryError(policy, data.user.defaultExpiry),
  );
  const expiryError = $derived(defaultExpiryError(policy, expiryValue(draft)));
  function save() {
    return saveSettings(
      'preferences',
      {
        ...(!data.displayNameRestricted &&
          draft.displayName !== baseline.displayName && {
            displayName: draft.displayName,
          }),
        ...(draft.stripImageMetadata !== baseline.stripImageMetadata && {
          stripImageMetadata: draft.stripImageMetadata,
        }),
        ...(expiryValue(draft) !== expiryValue(baseline) && {
          expiry: expiryValue(draft),
        }),
      },
      () => {
        draft.displayName = draft.displayName.trim();
        baseline = { ...draft };
        lastSaveData = data;
      },
    );
  }
  let modal = $state('');
  let modalRevision = $state(0);
  let busy = $state(false);
  let savingPreferences = $state(false);
  let token = $state('');
  let error = $state('');
  let secret = $state('');
  let config = $state<unknown>(null);
  let revoked = $state(false);
  function open(name: string) {
    modalRevision++;
    modal = name;
    error = token = '';
  }
  function close() {
    if (busy) return;
    modal = secret = token = error = '';
    config = null;
    if (revoked) void goto('/login', { refreshAll: true });
  }
  async function rotate(event: SubmitEvent) {
    event.preventDefault();
    if (busy || !token) return;
    busy = true;
    error = '';
    try {
      const result = await action('rotate', { token });
      revoked = true;
      secret = String(result.key);
      config = result.config;
      token = '';
      modal = 'new-key';
    } catch (error_) {
      error =
        error_ instanceof Error
          ? error_.message
          : 'Could not rotate your key. Please try again.';
    } finally {
      busy = false;
    }
  }
</script>

<SettingsPage bind:data suspended={!!modal} bypass={revoked}>
  <SettingsSection
    title="Personal preferences"
    description="Your profile and defaults for future uploads."
  >
    <SettingsForm
      bind:pending={savingPreferences}
      {dirty}
      invalid={!!expiryError && expiryValue(draft) !== expiryValue(baseline)}
      saveLabel="Save preferences"
      {save}
      {reset}
    >
      <SettingsRow
        id="display-name"
        label="Display name"
        description={data.displayNameRestricted
          ? 'Display name changes are disabled by your administrator.'
          : 'How your account appears in Hearth.'}
        info="Your name is shown in the workspace and to administrators. Changing it does not change your API key, uploaded images, or share links."
      >
        <input
          id="display-name"
          name="displayName"
          disabled={data.displayNameRestricted}
          bind:value={draft.displayName}
          required
          maxlength="80"
        />
      </SettingsRow>
      <SettingsRow
        id="default-expiry"
        label="Default image expiry"
        description="Used automatically unless an API or ShareX upload specifies an expiry."
        info="The expiry period starts when an image is uploaded. Browser uploads use this saved default; API and ShareX uploads may specify another expiry within your account's effective policy. Administrators are exempt. Changing the default does not alter existing images."
      >
        {#snippet detail()}
          {#if policy.source === 'administrator'}<p>
              Administrators are exempt from expiry restrictions.
            </p>
          {:else if policy.requireExpiry || policy.maxLifetimeSeconds !== null}<p
            >
              {policy.source === 'custom'
                ? 'Your account policy'
                : 'Workspace policy'} requires expiry.{policy.maxLifetimeSeconds ===
              null
                ? ''
                : ` Maximum lifetime: ${formatLifetime(policy.maxLifetimeSeconds)} after upload.`}
            </p>{/if}
          {#if savedDefaultError}<p class="error" role="alert">
              Your saved default is no longer allowed. Choose a valid duration
              and save preferences before uploading.
            </p>{/if}
        {/snippet}
        <select
          id="default-expiry"
          name="expiry"
          bind:value={draft.expiry}
          required
          aria-invalid={!!expiryError}
        >
          {#if draft.expiry !== 'duration' && choices.every(([value]) => value !== draft.expiry)}<option
              value={draft.expiry}
              disabled
              hidden>Choose a valid expiry</option
            >{/if}
          {#each choices as [value, label] (value)}<option {value}
              >{label}</option
            >{/each}
          <option value="duration">Custom duration</option>
        </select>
      </SettingsRow>
      {#if draft.expiry === 'duration'}
        <SettingsRow
          id="default-duration"
          label="Default duration (seconds)"
          description="A positive whole number of seconds."
          info="This duration is measured from each future upload. It must fit within your account's maximum lifetime, if one applies."
        >
          <input
            id="default-duration"
            class="settings-number"
            type="number"
            min="1"
            max={policy.maxLifetimeSeconds ?? undefined}
            step="1"
            bind:value={draft.seconds}
            required
            aria-invalid={!!expiryError}
          />
        </SettingsRow>
      {/if}
      {#if dirty && expiryError && expiryValue(draft) !== expiryValue(baseline)}<p
          class="settings-message error"
          role="status"
        >
          {expiryError}
        </p>{/if}
      <SettingsRow
        id="strip-metadata"
        label="Strip image metadata"
        toggle
        description="Remove unnecessary embedded details from future uploads."
        info="Removes unnecessary EXIF, GPS, device details, comments, and other descriptors without recompressing pixels. Required orientation, color profiles, transparency, and animation information remain; profiles may still contain descriptions. Existing images are unchanged. Unsupported sanitization fails instead of storing an unsanitized file."
      >
        <SettingsToggle
          id="strip-metadata"
          bind:checked={draft.stripImageMetadata}
        />
      </SettingsRow>
    </SettingsForm>
  </SettingsSection>

  <SettingsSection
    title="API key"
    description="Keep your key and downloaded configurations private."
  >
    <SettingsRow
      label="Account credential"
      description={`Last rotated: ${date(data.key?.rotatedAt || data.key?.createdAt || null)}`}
      info="Hearth cannot show your stored key again. It grants access to your account. Rotation immediately invalidates the old key, all sessions, and existing ShareX configurations. Save the replacement key and update ShareX; rotation cannot be undone."
    >
      {#snippet detail()}
        Rotating your key immediately signs out all sessions and invalidates
        existing ShareX configurations. This cannot be undone.
      {/snippet}
      <span class="settings-credential" aria-label="API key stored"
        >•••• ••••</span
      >
      <button
        class="danger"
        disabled={busy || savingPreferences}
        onclick={() => open('rotate')}><RefreshCw size={16} />Rotate key</button
      >
    </SettingsRow>
    <SettingsRow
      label="ShareX configuration"
      description="Connect ShareX using your current API key."
      info="Enter your saved API key to download a ShareX configuration. The downloaded file contains that key, so keep it private. After rotating a key, download a replacement configuration."
    >
      <button disabled={busy || savingPreferences} onclick={() => open('sxcu')}
        ><Download size={16} />Download ShareX configuration</button
      >
    </SettingsRow>
  </SettingsSection>

  <SettingsSection title="Setup guide">
    <SettingsRow
      label="Onboarding"
      description="Review your preferences and ShareX setup."
    >
      <a
        class="button"
        href="/onboarding?revisit=1"
        data-sveltekit-preload-data="false"
        data-sveltekit-preload-code="false"
        >Revisit onboarding<ArrowRight size={16} /></a
      >
    </SettingsRow>
  </SettingsSection>
  <SettingsSection title="About">
    <div class="settings-about">
      <strong><Flame size={14} />hearth v{version}</strong>
      <span><Copyright size={14} />Copyright (C) 2026 a9x Development</span>
      <a
        href="https://www.gnu.org/licenses/gpl-3.0.html"
        target="_blank"
        rel="noopener noreferrer"><Scale size={14} />GPL-3.0-or-later</a
      >
      <a
        href="https://github.com/sponsors/nota9x"
        target="_blank"
        rel="noopener noreferrer"
        ><Heart size={14} />Donate<ArrowUpRight size={14} /></a
      >
    </div>
  </SettingsSection>
</SettingsPage>

{#key modalRevision}{#if modal}<Modal
      title={modal === 'new-key'
        ? 'Save your API key'
        : modal === 'rotate'
          ? 'Rotate API key'
          : 'Set up ShareX'}
      onClose={close}
      {busy}
    >
      {#if modal === 'new-key'}
        <p>This key is shown once. Save it before closing this window.</p>
        <div class="secret">{secret}</div>
        <div class="toolbar">
          <Copy text={secret} label="Copy API key" />
          {#if config}<button onclick={() => downloadConfig(config)}
              ><Download size={16} />Download ShareX configuration</button
            >{/if}
        </div>
        <button onclick={close}>I’ve saved it</button>
      {:else if modal === 'sxcu'}
        <ShareXConfig
          bind:busy
          onDownload={() => {
            busy = false;
            close();
          }}
        >
          {#snippet field(id: string, control: Snippet)}
            <SettingsRow
              {id}
              label="Current API key"
              info="Use the key you saved when your account was created or last rotated. Hearth verifies it before generating the configuration. The downloaded file includes the key; keep it private."
            >
              {@render control()}
            </SettingsRow>
          {/snippet}
        </ShareXConfig>
      {:else}
        <form class="form-grid" onsubmit={rotate}>
          <p>
            Your old key and all signed-in sessions will stop working
            immediately. Existing ShareX configurations must be replaced.
            Rotation cannot be undone; save the replacement before leaving.
          </p>
          {#if dirty}<p class="notice">
              Your unsaved preferences will be lost when you sign in again.
              Cancel and save them first to keep those changes.
            </p>{/if}
          {#if error}<p class="error" role="alert">{error}</p>{/if}
          <Turnstile
            siteKey={data.siteKey}
            action="rotate"
            onToken={(value: string) => (token = value)}
          />
          <div class="settings-buttons">
            <button type="button" disabled={busy} onclick={close}>Cancel</button
            >
            <button class="danger" disabled={busy || !token}
              >{busy ? 'Rotating…' : 'Rotate API key'}</button
            >
          </div>
        </form>
      {/if}
    </Modal>{/if}{/key}
