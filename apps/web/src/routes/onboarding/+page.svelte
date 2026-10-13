<script lang="ts">
  import {
    defaultExpiryError,
    expiryChoices,
    expiryLabel,
  } from '@hearth/core/expiry-policy';
  import { onboardingSteps } from '@hearth/core/onboarding-view';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import Check from '@lucide/svelte/icons/check';
  import CheckCheck from '@lucide/svelte/icons/check-check';
  import Clock from '@lucide/svelte/icons/clock';
  import Download from '@lucide/svelte/icons/download';
  import Globe from '@lucide/svelte/icons/globe';
  import Image from '@lucide/svelte/icons/image';
  import Layers from '@lucide/svelte/icons/layers';
  import Link from '@lucide/svelte/icons/link';
  import LockKeyhole from '@lucide/svelte/icons/lock-keyhole';
  import Upload from '@lucide/svelte/icons/upload';
  import { onMount, tick, untrack } from 'svelte';

  import Brand from '#lib/Brand.svelte';
  import { action, ActionError } from '#lib/client.ts';
  import { notify } from '#lib/notifications.ts';
  import {
    clearOnboardingKey,
    takeOnboardingKey,
  } from '#lib/onboarding-key.ts';
  import Pagination from '#lib/Pagination.svelte';
  import ShareXConfig from '#lib/ShareXConfig.svelte';
  import Spinner from '#lib/Spinner.svelte';
  import {
    beforeNavigate,
    goto,
    onNavigate,
    refreshAll,
  } from '$app/navigation';

  import type { PageProps as PageProperties } from './$types';
  import FirstImage from './FirstImage.svelte';
  import { dashboardMotion, stepMotion } from './motion';

  const { data }: PageProperties = $props();
  let step = $state(untrack(() => data.startStep));
  let displayName = $state(untrack(() => data.user.displayName));
  let domainId = $state<string | null>(
    untrack(() => data.user.preferredDeliveryDomainId),
  );
  let expiry = $state(untrack(() => data.user.defaultExpiry));
  let seconds = $state<number | undefined>(
    untrack(() =>
      /^\d+s$/.test(data.user.defaultExpiry)
        ? Number(data.user.defaultExpiry.slice(0, -1))
        : 3600,
    ),
  );
  let customDuration = $state(
    untrack(() => /^\d+s$/.test(data.user.defaultExpiry)),
  );
  const savedPreferences = untrack(() => ({
    displayName: data.user.displayName,
    domainId: data.user.preferredDeliveryDomainId,
    expiry: data.user.defaultExpiry,
  }));
  $effect(() => {
    const user = data.user;
    untrack(() => {
      if (displayName === savedPreferences.displayName)
        displayName = user.displayName;
      if (domainId === savedPreferences.domainId)
        domainId = user.preferredDeliveryDomainId;
      if (expiry === savedPreferences.expiry) {
        expiry = user.defaultExpiry;
        customDuration = /^\d+s$/.test(expiry);
        seconds = customDuration ? Number(expiry.slice(0, -1)) : 3600;
      }
      savedPreferences.displayName = user.displayName;
      savedPreferences.domainId = user.preferredDeliveryDomainId;
      savedPreferences.expiry = user.defaultExpiry;
    });
  });
  let busy = $state(false);
  let enteringDashboard = $state(false);
  let onboarding = $state<HTMLDivElement>();
  let completed = $state<number[]>([]);
  let setupHostname = $state('');
  let setupDomain = $state(
    untrack(
      () =>
        data.primaryDomain ??
        (data.setupDomains.length === 1 ? data.setupDomains[0] : null),
    ),
  );
  let error = $state('');
  let key = $state('');
  let downloaded = $state(false);
  let uploadStatus = $state(untrack(() => data.user.onboardingUploadStatus));
  let uploadImageId = $state(untrack(() => data.user.onboardingUploadImageId));
  let armRequest: Promise<void> | undefined;
  let savedStep = untrack(() => data.user.onboardingStep);
  let heading = $state<HTMLHeadingElement>();
  let credentialTimer: ReturnType<typeof setTimeout> | undefined;
  const credentialOwner = untrack(() => data.user.id);
  $effect(() => {
    if (data.user.id !== credentialOwner) clearCredential();
  });
  $effect(() => {
    uploadStatus = data.user.onboardingUploadStatus;
    uploadImageId = data.user.onboardingUploadImageId;
  });
  const stages = $derived(
    onboardingSteps
      .map((label, index) => ({ label, index }))
      .filter((item) => data.bootstrap || item.index !== 1),
  );
  const position = $derived(stages.findIndex((item) => item.index === step));
  const choices = $derived(
    expiryChoices(data.expiryPolicy!).filter(([value]) => value !== 'custom'),
  );
  const expiryError = $derived(defaultExpiryError(data.expiryPolicy!, expiry));
  const selectedDomain = $derived(
    domainId === null
      ? data.available.find((domain) => domain.isPrimary)
      : data.available.find((domain) => domain.id === domainId),
  );
  const nameError = $derived(
    displayName.trim().length === 0
      ? 'Enter a name people will recognize.'
      : displayName.trim().length > 80
        ? 'Use 80 characters or fewer.'
        : '',
  );

  function clearCredential() {
    key = '';
    clearTimeout(credentialTimer);
    clearOnboardingKey();
  }
  async function signedOut() {
    clearCredential();
    await goto('/login', { refreshAll: true });
  }
  beforeNavigate(({ to }) => {
    if (to?.url.pathname !== '/onboarding') clearCredential();
  });
  onNavigate((navigation) => {
    if (enteringDashboard && navigation.to?.url.pathname === '/' && onboarding)
      return dashboardMotion(onboarding, navigation.complete);
  });
  onMount(() => {
    if (step === 5) void ensureUploadArmed().catch(() => {});
    if (data.revisit) {
      clearOnboardingKey();
    } else {
      const handoff = takeOnboardingKey(data.user.id);
      if (handoff) {
        key = handoff.key;
        credentialTimer = setTimeout(
          clearCredential,
          handoff.expiresAt - Date.now(),
        );
      }
    }
    window.addEventListener('pagehide', clearCredential);
    return () => {
      clearCredential();
      window.removeEventListener('pagehide', clearCredential);
    };
  });

  async function ensureUploadArmed() {
    if (uploadStatus === 'waiting' || uploadStatus === 'verified') return;
    if (!armRequest)
      armRequest = (async () => {
        const result = await action<{
          status: typeof uploadStatus;
          imageId: string | null;
        }>('onboarding-upload-arm');
        uploadStatus = result.status;
        uploadImageId = result.imageId;
      })();
    try {
      await armRequest;
    } finally {
      armRequest = undefined;
    }
  }

  async function show(next: number, fromContinue = false) {
    if (next === step || (busy && !fromContinue)) return;
    const wasBusy = busy;
    busy = true;
    try {
      error = '';
      if (next === 5 || next === 6) {
        try {
          await ensureUploadArmed();
          if (!data.revisit && next > savedStep) {
            await action('onboarding-progress', { step: next });
            savedStep = next;
          }
        } catch (error_) {
          error =
            error_ instanceof Error
              ? error_.message
              : 'Could not start the upload check.';
        }
      }
      step = next;
      await tick();
      heading?.focus({ preventScroll: true });
      heading?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    } finally {
      busy = wasBusy;
    }
  }
  async function refresh() {
    await refreshAll();
  }
  async function continueSetup(skip = false) {
    if (busy) return;
    busy = true;
    error = '';
    try {
      if (!skip && step === 2 && displayName.trim() !== data.user.displayName)
        await action('preferences', { displayName });
      if (
        !skip &&
        step === 3 &&
        domainId !== data.user.preferredDeliveryDomainId
      )
        await action('delivery-preference', { deliveryDomainId: domainId });
      if (!skip && step === 4 && expiry !== data.user.defaultExpiry)
        await action('preferences', { expiry });
      if (step === 6 && skip) {
        const result = await action<{
          status: typeof uploadStatus;
          imageId: string | null;
        }>('onboarding-upload-skip');
        uploadStatus = result.status;
        uploadImageId = result.imageId;
      }
      const next = stages[position + 1]?.index ?? 7;
      if (!data.revisit) {
        const result = await action<{
          onboardingStatus: string;
          onboardingStep: number;
        }>(
          next === 7 ? 'onboarding-complete' : 'onboarding-progress',
          next === 7 ? {} : { step: next },
        );
        if (next !== 7 && result.onboardingStatus !== 'pending') {
          clearCredential();
          await goto('/', { refreshAll: true });
          return;
        }
        savedStep = result.onboardingStep;
      }
      await refresh();
      if (next === 7) clearCredential();
      if (!skip && !completed.includes(step)) completed = [...completed, step];
      await show(next, true);
    } catch (error_) {
      error =
        error_ instanceof Error
          ? error_.message
          : 'Could not save. Please try again.';
      if (error_ instanceof ActionError && error_.status === 401)
        await signedOut();
    } finally {
      busy = false;
    }
  }
  async function skipOnboarding() {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await action('onboarding-skip');
      clearCredential();
      await goto('/', { refreshAll: true });
      notify.info('You can revisit onboarding anytime', 8000, {
        guidance:
          "You can restart the guided setup whenever you'd like from your user settings.",
        link: { href: '/settings', label: 'Open settings' },
      });
    } catch (error_) {
      error =
        error_ instanceof Error
          ? error_.message
          : 'Could not leave setup. Please try again.';
      if (error_ instanceof ActionError && error_.status === 401)
        await signedOut();
    } finally {
      busy = false;
    }
  }
  async function enterDashboard() {
    if (busy) return;
    busy = true;
    enteringDashboard = true;
    error = '';
    try {
      if (data.user.onboardingStatus === 'pending')
        await action('onboarding-complete');
      clearCredential();
      await goto('/', { refreshAll: true });
    } catch (error_) {
      error =
        error_ instanceof Error
          ? error_.message
          : 'Could not open the dashboard. Please try again.';
      if (error_ instanceof ActionError && error_.status === 401)
        await signedOut();
    } finally {
      enteringDashboard = false;
      busy = false;
    }
  }
</script>

<svelte:head><title>{data.siteName} · Setup</title></svelte:head>

<div
  class="onboarding"
  bind:this={onboarding}
  aria-busy={busy}
  inert={enteringDashboard}
>
  <header class="onboarding-header">
    <Brand name={data.siteName} href="/onboarding" />
    <div class="header-actions">
      <button
        class="skip-onboarding"
        disabled={busy}
        onclick={() => void skipOnboarding()}
        aria-label="Skip onboarding"
        >Skip onboarding<ArrowRight size={15} /></button
      >
    </div>
  </header>
  <nav class="journey" aria-label="Setup progress">
    <ol>
      {#each stages as stage (stage.index)}<li
          class:current={step === stage.index}
          class:completed={completed.includes(stage.index)}
        >
          <button
            type="button"
            disabled={busy}
            aria-current={step === stage.index ? 'step' : undefined}
            aria-label={`${stage.label}${completed.includes(stage.index) ? ', completed' : ''}`}
            onclick={() => void show(stage.index)}
            ><span class="step-dot" aria-hidden="true"
              >{#if completed.includes(stage.index)}<Check
                  size={12}
                />{:else}{stages.indexOf(stage) + 1}{/if}</span
            ><span class="step-label">{stage.label}</span></button
          >
        </li>{/each}
    </ol>
    <p class="mobile-progress">
      {position + 1} of {stages.length} · {onboardingSteps[step]}
    </p>
  </nav>
  <div class="step-frame">
    {#key step}
      <section class="step-layout" transition:stepMotion>
        <div class="intro">
          <h1 bind:this={heading} tabindex="-1">
            {step === 0
              ? `Welcome to ${data.siteName}`
              : step === 1
                ? 'Set up delivery'
                : step === 2
                  ? 'Your display name'
                  : step === 3
                    ? 'Your share links'
                    : step === 4
                      ? 'Image lifetime'
                      : step === 5
                        ? 'Connect ShareX'
                        : step === 6
                          ? 'Try your first image'
                          : 'Ready to continue'}
          </h1>
          <p class="introduction">
            {step === 0
              ? 'Set up your account, choose upload defaults, and connect ShareX. Every step is optional.'
              : step === 1
                ? 'Your application is where you manage images. A delivery domain is the address people visit to see them.'
                : step === 2
                  ? 'Your display name appears in your account and administrator activity records.'
                  : step === 3
                    ? 'Choose the hostname for links created from your uploads. Your ShareX uploader will follow this saved selection.'
                    : step === 4
                      ? 'Choose how long newly uploaded images stay available. Existing images keep their current expiration dates.'
                      : step === 5
                        ? 'Download and import your uploader configuration to upload images directly from ShareX.'
                        : step === 6
                          ? 'Take a screenshot in ShareX. Hearth will recognize it when the upload is complete.'
                          : 'Review your saved settings. You can update them anytime in Settings.'}
          </p>
          {#if step === 0}<div class="welcome-notes">
              <span
                ><LockKeyhole size={16} />Use your current API key for ShareX.</span
              ><span><Clock size={16} />This should take about 5 minutes.</span>
            </div>{:else if step === 5}<div class="privacy-note">
              <LockKeyhole size={17} />
              <p>
                Your login and ShareX use the same API key. Keep your downloaded
                configuration private. After a refresh or 15 minutes, enter your
                current key manually.
              </p>
            </div>{:else if step === 7}<div class="finish-note">
              <CheckCheck size={19} /><span
                >Reopen setup with Revisit onboarding in Settings.</span
              >
            </div>{/if}
        </div>

        <div class="step-content">
          {#if step === 0}
            <div
              class="workflow"
              aria-label="Upload an image, share its link, and manage it in Hearth"
            >
              <div class="image-scene">
                <div class="scene-sun"></div>
                <div class="scene-hill hill-back"></div>
                <div class="scene-hill hill-front"></div>
                <span class="scene-caption"
                  ><Image size={14} />Example image</span
                >
              </div>
              <div class="workflow-steps">
                <div>
                  <span class="workflow-icon"><Upload size={19} /></span><strong
                    >Upload</strong
                  ><small>Capture with ShareX</small>
                </div>
                <span class="workflow-arrow"><ArrowRight size={16} /></span>
                <div>
                  <span class="workflow-icon"><Link size={19} /></span><strong
                    >Share</strong
                  ><small>Copy a share link</small>
                </div>
                <span class="workflow-arrow"><ArrowRight size={16} /></span>
                <div>
                  <span class="workflow-icon"><Layers size={19} /></span><strong
                    >Manage</strong
                  ><small>Browse your images</small>
                </div>
              </div>
            </div>
          {:else if step === 1}
            <div class="setup-surface">
              <span class="surface-label"
                ><Globe size={16} />Initial instance setup</span
              >
              {#await import('./DomainSetup.svelte')}<p class="loading">
                  <Spinner size={18} />Opening domain setup…
                </p>{:then module}<module.default
                  domains={data.setupDomains}
                  bind:domain={setupDomain}
                  bind:hostname={setupHostname}
                  bind:busy
                  {refresh}
                  onExpired={() => void signedOut()}
                />{/await}
              {#if data.setupPagination && data.setupPagination.pages > 1}<Pagination
                  current={data.setupPagination.page}
                  pages={data.setupPagination.pages}
                  total={data.setupPagination.total}
                  size={data.setupPagination.size}
                />{/if}
            </div>
          {:else if step === 2}
            <div class="identity-preview" aria-hidden="true">
              <span class="identity-avatar"
                >{displayName.trim().slice(0, 1).toUpperCase() || 'H'}</span
              ><strong>{displayName.trim() || 'Your name'}</strong><small
                >{data.user.role === 'admin' ? 'Administrator' : 'Member'} · {data.siteName}</small
              >
            </div>
            <form
              id="step-form"
              onsubmit={(event) => {
                event.preventDefault();
                void continueSetup();
              }}
            >
              <label
                >Your display name<input
                  bind:value={displayName}
                  disabled={busy}
                  autocomplete="nickname"
                  maxlength="80"
                  required
                  aria-describedby="name-help"
                  aria-invalid={!!nameError}
                /></label
              >
              <p id="name-help" class:error={!!nameError}>
                {nameError || 'You can change this later in Settings.'}
              </p>
            </form>
          {:else if step === 3}
            <fieldset class="choices">
              <legend>Your delivery selection</legend><label
                class="choice"
                class:selected={domainId === null}
                ><input
                  type="radio"
                  name="domain"
                  disabled={busy}
                  value="primary"
                  checked={domainId === null}
                  onchange={() => (domainId = null)}
                /><span
                  ><strong>Use instance default</strong><small
                    >{data.primaryDomain?.hostname ??
                      'No instance default configured'}</small
                  ></span
                ><span class="choice-mark"><Check size={15} /></span></label
              >{#each data.available as domain (domain.id)}<label
                  class="choice"
                  class:selected={domainId === domain.id}
                  ><input
                    type="radio"
                    name="domain"
                    disabled={busy}
                    value={domain.id}
                    checked={domainId === domain.id}
                    onchange={() => (domainId = domain.id)}
                  /><span
                    ><strong>{domain.hostname}</strong><small
                      >{domain.isPrimary
                        ? 'Instance default · Use for your new share links'
                        : 'Use for your new share links'}</small
                    ></span
                  ><span class="choice-mark"><Check size={15} /></span></label
                >{/each}
            </fieldset>
            {#if domainId && data.available.every((domain) => domain.id !== domainId)}<p
                class="attention"
              >
                Your saved delivery selection is unavailable. Choose an
                available domain or keep your current selection for now.
              </p>{/if}
            {#if domainId === null && !selectedDomain}<p class="attention">
                {data.primaryDomain
                  ? 'The instance default is unavailable for your new share links. Choose an available domain or keep following the instance default for now.'
                  : 'No instance default is configured. Choose an available domain or keep following the instance default for now.'}
              </p>{/if}
            {#if data.available.length === 0}<div class="empty-guidance">
                <Globe size={22} /><strong
                  >No delivery domains available yet</strong
                >
                <p>
                  You can continue. Images save privately until a usable
                  delivery domain is configured.{data.user.role === 'admin'
                    ? ' You can finish setup in Administration → Domains.'
                    : ' Ask your administrator to configure one.'}
                </p>
              </div>{:else if selectedDomain}<div class="link-preview">
                <Link size={15} /><span
                  >{selectedDomain.hostname}<span class="link-tail"
                    >/your-image</span
                  ></span
                ><small>Example link</small>
              </div>{/if}
          {:else if step === 4}
            <fieldset class="choices expiry-choices">
              <legend>Default image expiration</legend
              >{#each choices as [value, label] (value)}<label
                  class="choice"
                  class:selected={expiry === value && !customDuration}
                  ><input
                    type="radio"
                    name="expiry"
                    disabled={busy}
                    {value}
                    checked={expiry === value && !customDuration}
                    onchange={() => {
                      expiry = value;
                      customDuration = false;
                    }}
                  /><span
                    ><strong
                      >{value === 'never' ? 'Keep indefinitely' : label}</strong
                    ><small
                      >{value === 'never'
                        ? 'Until you decide to delete it'
                        : `Automatically expires ${label.toLowerCase()} after upload`}</small
                    ></span
                  ><span class="choice-mark"><Check size={15} /></span></label
                >{/each}<label class="choice" class:selected={customDuration}
                ><input
                  type="radio"
                  name="expiry"
                  disabled={busy}
                  value="duration"
                  checked={customDuration}
                  onchange={() => {
                    customDuration = true;
                    expiry = `${seconds ?? 3600}s`;
                  }}
                /><span
                  ><strong>A custom duration</strong><small
                    >Choose the number of seconds</small
                  ></span
                ><span class="choice-mark"><Check size={15} /></span></label
              >
            </fieldset>
            {#if customDuration}<form
                id="step-form"
                onsubmit={(event) => {
                  event.preventDefault();
                  void continueSetup();
                }}
              >
                <label
                  >Duration in seconds<input
                    type="number"
                    disabled={busy}
                    min="1"
                    step="1"
                    max={data.expiryPolicy!.maxLifetimeSeconds ?? undefined}
                    required
                    bind:value={seconds}
                    aria-invalid={!!expiryError}
                    aria-describedby={expiryError ? 'expiry-error' : undefined}
                    oninput={(event) =>
                      (expiry = `${event.currentTarget.value}s`)}
                  /></label
                >
              </form>{/if}
            {#if expiryError}<p
                id="expiry-error"
                class="attention"
                role="status"
              >
                {expiryError} You can keep this setting for now and change it later.
              </p>{/if}
            {#if data.expiryPolicy!.requireExpiry || data.expiryPolicy!.maxLifetimeSeconds !== null}<p
                class="policy-note"
              >
                Your administrator’s expiration policy applies to new uploads.
              </p>{/if}
          {:else if step === 5}
            <div class="sharex-download">
              <span class="surface-label"
                ><Download size={16} />ShareX configuration</span
              ><ShareXConfig
                bind:key
                bind:busy
                onDownload={() => (downloaded = true)}
                onExpired={() => void signedOut()}
              />{#if downloaded}<p class="download-success" role="status">
                  <Check size={15} />Configuration download started. Follow the
                  steps below.
                </p>{/if}
            </div>
            {#if data.selection.warning}<p class="attention">
                {data.selection.warning} You can download the configuration now. Until
                sharing is configured, images save privately and ShareX reports that
                no share link is available.
              </p>{/if}
            {#if defaultExpiryError(data.expiryPolicy!, data.user.defaultExpiry)}<p
                class="attention"
              >
                Your saved image expiration needs attention before uploading.
                Choose an allowed lifetime in the previous step or in Settings.
              </p>{/if}
            <ol class="sharex-instructions">
              <li>
                <span class="instruction-number">1</span>
                <div>
                  <strong>Open your .sxcu file</strong>
                  <p>
                    Double-click it with ShareX installed. Click Yes when ShareX
                    asks to set “Hearth” as the active custom uploader for
                    images/files.
                  </p>
                </div>
              </li>
              <li>
                <span class="instruction-number">2</span>
                <div>
                  <strong>Enable automatic uploads</strong>
                  <p>
                    In ShareX, open After capture tasks and enable Upload image
                    to host.
                  </p>
                </div>
              </li>
              <li>
                <span class="instruction-number">3</span>
                <div>
                  <strong>Check the connection</strong>
                  <p>
                    Continue to the next step to take a screenshot and see if it
                    reaches Hearth.
                  </p>
                </div>
              </li>
            </ol>
          {:else if step === 6}
            <FirstImage
              initialStatus={uploadStatus}
              initialImageId={uploadImageId}
              onChange={(
                status: 'waiting' | 'verified' | 'skipped' | null,
                imageId: string | null,
              ) => {
                uploadStatus = status;
                uploadImageId = imageId;
              }}
              onExpired={() => void signedOut()}
            />
          {:else}
            <div class="completion-card">
              <h2>Saved settings</h2>
              <dl>
                <div>
                  <dt>Display name</dt>
                  <dd>{data.user.displayName}</dd>
                </div>
                <div>
                  <dt>Delivery</dt>
                  <dd>
                    {data.selection.domain?.hostname ?? 'Setup still needed'}
                  </dd>
                </div>
                <div>
                  <dt>Image lifetime</dt>
                  <dd>
                    {expiryLabel(
                      data.user.defaultExpiry,
                    )}{#if defaultExpiryError(data.expiryPolicy!, data.user.defaultExpiry)}<small
                        >Needs attention</small
                      >{/if}
                  </dd>
                </div>
                <div>
                  <dt>ShareX</dt>
                  <dd>
                    {downloaded
                      ? 'Configuration download started'
                      : 'Available in Settings'}
                  </dd>
                </div>
                <div>
                  <dt>First image</dt>
                  <dd>
                    {uploadStatus === 'verified'
                      ? 'Upload received'
                      : uploadStatus === 'skipped'
                        ? 'Skipped'
                        : 'Not tested'}
                  </dd>
                </div>
              </dl>
            </div>
            {#if data.selection.warning}<p class="attention">
                Sharing still needs a usable delivery domain. You can finish
                setup later; your saved images remain available in Hearth.
              </p>{/if}
          {/if}
        </div>
      </section>
    {/key}
  </div>
  <footer class="onboarding-footer">
    {#if error}<p class="save-error" role="alert">{error}</p>{/if}
    <div class="footer-navigation">
      <div>
        {#if position > 0}<button
            class="back"
            disabled={busy}
            onclick={() => void show(stages[position - 1].index)}
            ><ArrowLeft size={16} />Back</button
          >{/if}
      </div>
      <div class="forward-actions">
        {#if step === 7}<button
            class="primary continue"
            disabled={busy}
            onclick={() => void enterDashboard()}
            >{enteringDashboard
              ? 'Opening dashboard…'
              : 'Go to dashboard'}{#if enteringDashboard}<Spinner
                size={17}
              />{:else}<ArrowRight size={17} />{/if}</button
          >
        {:else}<button
            class="step-skip"
            disabled={busy}
            onclick={() => void continueSetup(true)}>Skip</button
          ><button
            class="primary continue"
            type={step === 2 || (step === 4 && customDuration)
              ? 'submit'
              : 'button'}
            form={step === 2 || (step === 4 && customDuration)
              ? 'step-form'
              : undefined}
            disabled={busy ||
              (step === 1 &&
                (!data.primaryDomain?.enabled ||
                  data.primaryDomain.health !== 'active')) ||
              (step === 2 && !!nameError) ||
              (step === 4 && !!expiryError) ||
              (step === 6 && uploadStatus !== 'verified')}
            onclick={step === 2 || (step === 4 && customDuration)
              ? undefined
              : () => void continueSetup()}
            >{busy
              ? 'Saving…'
              : step === 0
                ? 'Get started'
                : step === 1
                  ? 'Continue setup'
                  : step === 5
                    ? 'Check an image'
                    : step === 6
                      ? 'Continue'
                      : 'Save & continue'}{#if busy}<Spinner
                size={17}
              />{:else}<ArrowRight size={17} />{/if}</button
          >{/if}
      </div>
    </div>
  </footer>
  <div class="sr-only" role="status" aria-live="polite">
    Step {position + 1} of {stages.length}: {onboardingSteps[step]}
  </div>
</div>

<style>
  .onboarding {
    min-height: 100dvh;
    padding: 30px max(clamp(24px, 6vw, 88px), calc((100% - 1264px) / 2)) 26px;
    background:
      radial-gradient(ellipse at 18% 42%, #c4714a0a, transparent 60%),
      var(--page);
  }
  .onboarding-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 18px;
  }
  .header-actions {
    display: flex;
    align-items: center;
    gap: 22px;
  }
  .skip-onboarding,
  .back,
  .step-skip {
    background: transparent;
    border-color: transparent;
    color: var(--muted);
    font-size: 0.8rem;
  }
  .skip-onboarding {
    padding-inline: 8px;
  }
  .journey {
    margin: 42px 0 64px;
  }
  .journey ol {
    display: flex;
    list-style: none;
    padding: 0;
    margin: 0;
    gap: 0;
  }
  .journey li {
    display: flex;
    align-items: center;
    color: var(--faint);
    font-size: 0.7rem;
    flex: 1;
    position: relative;
    min-width: 0;
  }
  .journey button {
    gap: 9px;
    padding: 6px;
    min-width: 35px;
    min-height: 44px;
    color: inherit;
    font-size: inherit;
    background: transparent;
    border-color: transparent;
  }
  .journey button:hover:not(:disabled) {
    background: #c4714a10;
    color: #e9b898;
  }
  .journey button:active:not(:disabled) {
    background: #c4714a20;
  }
  .journey li:not(:last-child)::after {
    content: '';
    flex: 1;
    margin: 0 10px;
    height: 1px;
    background: var(--border);
  }
  .step-dot {
    width: 23px;
    height: 23px;
    display: grid;
    place-items: center;
    border: 1px solid var(--border);
    border-radius: 50%;
    font-family: ui-sans-serif, sans-serif;
    font-size: 0.65rem;
    transition:
      background-color 240ms var(--motion-enter),
      color 240ms var(--motion-enter);
    flex-shrink: 0;
  }
  .journey .current {
    color: #e9b898;
  }
  .completed .step-dot {
    color: #b8bf96;
    background: #b8bf9610;
    border-color: #b8bf9635;
  }
  .current .step-dot {
    color: #e9b898;
    border-color: #d1936e;
    background: #c4714a20;
  }
  .step-label {
    white-space: nowrap;
  }
  .mobile-progress {
    display: none;
  }
  .step-frame {
    position: relative;
  }
  .step-layout {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: clamp(32px, 6vw, 88px);
    align-items: start;
    min-height: 460px;
  }
  .step-layout:global([inert]) {
    position: absolute;
    top: 0;
    inset-inline: 0;
    pointer-events: none;
  }
  h1 {
    font-size: clamp(2.5rem, 4.3vw, 4rem);
    font-weight: 450;
    line-height: 1.1;
    letter-spacing: -0.045em;
    margin: 0 0 28px;
    overflow-wrap: anywhere;
  }
  h1:focus {
    outline: none;
  }
  .introduction {
    font-size: 0.93rem;
    line-height: 1.9;
    max-width: 390px;
    color: #b9a997;
    margin: 0;
  }
  .welcome-notes {
    display: grid;
    gap: 10px;
    margin-top: 36px;
    font-size: 0.73rem;
    color: var(--muted);
  }
  .welcome-notes span {
    display: flex;
    gap: 10px;
    align-items: center;
  }
  .welcome-notes :global(svg),
  .privacy-note :global(svg) {
    color: #bc8b68;
    flex-shrink: 0;
  }
  .step-content {
    min-width: 0;
    display: grid;
    gap: 20px;
  }
  .workflow {
    border: 1px solid #e8d5bc22;
    border-radius: 26px;
    padding: 25px;
    background: linear-gradient(145deg, #2c241d, #1c1916);
    box-shadow: 0 26px 70px #09070530;
    margin: 9px 0;
  }
  .image-scene {
    height: 195px;
    background: linear-gradient(170deg, #deb799, #af7c5d 55%, #655541);
    border-radius: 14px;
    overflow: hidden;
    position: relative;
  }
  .scene-sun {
    position: absolute;
    top: 27px;
    left: 62%;
    height: 44px;
    width: 44px;
    border-radius: 50%;
    background: #f9d4ac;
    box-shadow: 0 0 50px #f8c69340;
  }
  .scene-hill {
    position: absolute;
    width: 140%;
    height: 145px;
    border-radius: 50% 50% 0 0;
  }
  .hill-back {
    left: -55%;
    bottom: -38px;
    background: #655c4b;
    transform: rotate(16deg);
  }
  .hill-front {
    right: -55%;
    bottom: -66px;
    background: #3f483c;
    transform: rotate(-16deg);
  }
  .scene-caption {
    position: absolute;
    bottom: 15px;
    left: 15px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 6px 9px;
    border-radius: 8px;
    background: #17191265;
    color: #efe2cc;
    font-size: 0.6rem;
  }
  .workflow-steps {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 24px 0 0;
  }
  .workflow-steps > div {
    display: grid;
    justify-items: center;
    gap: 8px;
    text-align: center;
  }
  .workflow-icon {
    display: grid;
    place-items: center;
    height: 39px;
    width: 39px;
    border-radius: 12px;
    border: 1px solid #cda58130;
    color: #dba57c;
    background: #cda58109;
  }
  .workflow-steps strong {
    font-size: 0.76rem;
    font-weight: 550;
  }
  .workflow-steps small {
    font-size: 0.57rem;
    color: #ad9b88;
  }
  .workflow-arrow {
    color: #8b7966;
  }
  .identity-preview {
    display: grid;
    justify-items: center;
    gap: 10px;
    border: 1px solid #e8d5bc20;
    background: radial-gradient(ellipse at top, #c4714a13, #1e1b18 75%);
    border-radius: 24px;
    padding: 26px;
  }
  .identity-avatar {
    display: grid;
    place-items: center;
    height: 70px;
    width: 70px;
    border-radius: 24px;
    margin: 15px 0 4px;
    color: #f1c6a4;
    background: linear-gradient(150deg, #9a6043, #593e2c);
    box-shadow: 0 6px 20px #0002;
    font-size: 2rem;
  }
  .identity-preview strong {
    font-size: 1.2rem;
    font-weight: 500;
    overflow-wrap: anywhere;
    max-width: 100%;
    text-align: center;
  }
  .identity-preview small {
    font-size: 0.72rem;
    color: var(--muted);
  }
  #step-form p {
    margin: 9px 0 0;
    font-size: 0.73rem;
  }
  fieldset {
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
  }
  legend {
    font-size: 0.76rem;
    color: var(--muted);
    padding: 0;
    margin-bottom: 14px;
  }
  .choices {
    display: grid;
    gap: 10px;
  }
  .choice {
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 17px 18px;
    border: 1px solid var(--border);
    background: #1e1b18;
    border-radius: 14px;
    cursor: pointer;
    transition:
      background-color 220ms var(--motion-enter),
      border-color 220ms var(--motion-enter);
  }
  .choice:hover {
    border-color: #e8d5bc35;
  }
  .choice.selected {
    background: #c4714a10;
    border-color: #c4714a85;
  }
  .choice input {
    position: absolute;
    opacity: 0;
    width: 1px;
    height: 1px;
    margin: 0;
  }
  .choice:has(input:focus-visible) {
    outline: 2px solid #e6a479;
    outline-offset: 4px;
  }
  .choice > span:first-of-type {
    flex: 1;
    min-width: 0;
  }
  .choice strong {
    display: block;
    color: #e5d4c0;
    font-size: 0.9rem;
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .choice small {
    display: block;
    margin-top: 4px;
    color: var(--muted);
    font-size: 0.7rem;
  }
  .choice-mark {
    flex-shrink: 0;
    display: grid;
    place-items: center;
    height: 22px;
    width: 22px;
    border: 1px solid #e8d5bc30;
    border-radius: 50%;
    color: transparent;
    transition:
      background-color 220ms var(--motion-enter),
      color 220ms var(--motion-enter);
  }
  .selected .choice-mark {
    background: #c4714a;
    color: #160e09;
    border-color: #c4714a;
  }
  .expiry-choices {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .expiry-choices legend {
    grid-column: 1 / -1;
  }
  .expiry-choices .choice {
    padding: 14px;
  }
  .expiry-choices .choice strong {
    font-size: 0.8rem;
  }
  .link-preview {
    display: flex;
    align-items: center;
    gap: 9px;
    color: #d4a17b;
    background: #c4714a0b;
    padding: 14px;
    border-radius: 10px;
    border: 1px dashed #c4714a35;
    font-size: 0.72rem;
    flex-wrap: wrap;
  }
  .link-preview > span {
    font-family: ui-monospace, monospace;
    overflow-wrap: anywhere;
    flex: 1;
  }
  .link-tail {
    color: #957d68;
  }
  .link-preview small {
    font-size: 0.55rem;
    color: var(--faint);
  }
  .attention {
    margin: 0;
    color: #dfbc88;
    font-size: 0.75rem;
    line-height: 1.7;
    border-left: 2px solid #b3874a80;
    padding-left: 13px;
  }
  .empty-guidance {
    display: grid;
    gap: 12px;
    padding: 22px;
    border: 1px dashed #e8d5bc30;
    border-radius: 16px;
  }
  .empty-guidance > :global(svg) {
    color: #c79e77;
  }
  .empty-guidance strong {
    font-size: 0.87rem;
    font-weight: 500;
  }
  .empty-guidance p,
  .policy-note {
    font-size: 0.76rem;
    margin: 0;
  }
  .setup-surface,
  .sharex-download {
    padding: 25px;
    border: 1px solid #e8d5bc25;
    border-radius: 22px;
    background: #1e1b18;
  }
  .surface-label {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 22px;
    font-size: 0.73rem;
    color: #cda581;
  }
  .loading {
    display: flex;
    gap: 10px;
    align-items: center;
  }
  .privacy-note {
    display: flex;
    gap: 12px;
    max-width: 345px;
    margin-top: 30px;
    padding-top: 20px;
    border-top: 1px solid var(--border);
  }
  .privacy-note p {
    font-size: 0.74rem;
    line-height: 1.8;
    margin: 0;
  }
  .sharex-instructions {
    padding: 0;
    margin: 3px 0 0;
    display: grid;
    gap: 23px;
    list-style: none;
  }
  .sharex-instructions li {
    display: flex;
    align-items: start;
    gap: 13px;
  }
  .instruction-number {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border: 1px solid #c4714a35;
    border-radius: 9px;
    color: #dfb088;
    font-size: 0.7rem;
    flex-shrink: 0;
  }
  .sharex-instructions strong {
    font-size: 0.81rem;
    font-weight: 550;
  }
  .sharex-instructions p {
    font-size: 0.73rem;
    line-height: 1.8;
    margin: 5px 0 0;
  }
  .download-success {
    display: flex;
    align-items: center;
    gap: 8px;
    color: #b8bf96;
    font-size: 0.72rem;
    margin: 16px 0 0;
  }
  .completion-card {
    background: radial-gradient(ellipse at top, #c4714a13, #1e1b18 65%);
    border: 1px solid #e8d5bc25;
    border-radius: 26px;
    padding: 32px;
    text-align: center;
  }
  .completion-card h2 {
    margin: 0 0 25px;
    font-size: 1.7rem;
    font-weight: 450;
  }
  dl {
    margin: 0;
    text-align: left;
  }
  dl > div {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 20px;
    border-top: 1px solid var(--border);
    padding: 14px 0;
  }
  dt {
    color: var(--muted);
    font-size: 0.72rem;
    flex-shrink: 0;
  }
  dd {
    margin: 0;
    text-align: right;
    font-size: 0.78rem;
    overflow-wrap: anywhere;
  }
  dd small {
    display: block;
    color: #dfbc88;
  }
  .finish-note {
    display: flex;
    align-items: center;
    gap: 13px;
    margin-top: 32px;
    font-size: 0.76rem;
    color: #d2b899;
  }
  .finish-note :global(svg) {
    color: #b8bf96;
  }
  .onboarding-footer {
    margin-top: 54px;
    padding-top: 23px;
    border-top: 1px solid var(--border);
  }
  .footer-navigation {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
  }
  .forward-actions {
    display: flex;
    gap: 10px;
    align-items: center;
  }
  .continue {
    padding: 13px 23px;
    border-radius: 12px;
    font-size: 0.83rem;
    min-height: 48px;
  }
  .save-error {
    font-size: 0.8rem;
    color: var(--danger);
    margin: 0 0 16px;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  @media (max-width: 1050px) {
    .step-label {
      display: none;
    }
    .journey li:not(:last-child)::after {
      margin: 0 20px;
    }
    .journey {
      margin-bottom: 48px;
    }
  }
  @media (max-width: 767px) {
    .onboarding {
      padding: 22px 22px 26px;
    }
    .onboarding-header {
      align-items: start;
    }
    .header-actions {
      gap: 0;
    }
    .skip-onboarding {
      font-size: 0.67rem;
      gap: 5px;
      min-height: 32px;
      padding: 4px 0;
    }
    .journey {
      margin: 27px 0 34px;
    }
    .journey li:not(:last-child)::after {
      margin: 0 2px;
    }
    .mobile-progress {
      display: block;
      color: var(--muted);
      font-size: 0.65rem;
      margin: 13px 0 0;
    }
    .step-layout {
      grid-template-columns: 1fr;
      gap: 30px;
      min-height: 0;
    }
    h1 {
      font-size: clamp(2.7rem, 10vw, 4rem);
      margin-bottom: 20px;
    }
    .introduction {
      max-width: 100%;
      font-size: 0.85rem;
      line-height: 1.8;
    }
    .welcome-notes {
      margin-top: 20px;
      gap: 8px;
      font-size: 0.68rem;
    }
    .workflow {
      margin: 0;
      padding: 20px;
    }
    .image-scene {
      height: 180px;
    }
    .workflow-steps small {
      font-size: 0.51rem;
    }
    .workflow-arrow :global(svg) {
      width: 12px;
    }
    .setup-surface,
    .sharex-download,
    .completion-card {
      padding: 22px;
    }
    .onboarding-footer {
      margin-top: 32px;
    }
    .footer-navigation {
      align-items: center;
      gap: 5px;
    }
    .forward-actions {
      gap: 2px;
    }
    .step-skip {
      font-size: 0.69rem;
      padding-inline: 9px;
    }
    .continue {
      font-size: 0.77rem;
      padding-inline: 16px;
    }
    .privacy-note {
      margin-top: 20px;
    }
    .expiry-choices {
      gap: 8px;
    }
    .expiry-choices .choice {
      padding: 12px;
      gap: 8px;
    }
    .expiry-choices .choice small {
      font-size: 0.62rem;
    }
  }
  @media (max-width: 380px) {
    .expiry-choices {
      grid-template-columns: 1fr;
    }
    .workflow-steps small {
      max-width: 62px;
    }
    .skip-onboarding :global(svg) {
      display: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .journey button,
    .choice,
    .choice-mark,
    .step-dot {
      transition: none;
    }
  }
</style>
