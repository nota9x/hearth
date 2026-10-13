<script lang="ts">
  import './settings.css';

  import { onMount, setContext, type Snippet } from 'svelte';

  import {
    dashboard,
    dashboardSnapshot,
    setDashboardRefresh,
  } from '#lib/dashboard.ts';
  import DashboardNotice from '#lib/DashboardNotice.svelte';
  import Modal from '#lib/Modal.svelte';
  import { watchRefresh } from '#lib/refresh.ts';
  import { uploads } from '#lib/uploads.ts';
  import { beforeNavigate, goto } from '$app/navigation';
  import { navigating } from '$app/state';

  import type { PageData } from '../../routes/[...path]/$types';
  import { settingsContext, type SettingsState } from './settings';

  /* eslint-disable prefer-const -- Bindable props share one Svelte declaration. */
  let {
    admin = false,
    children,
    suspended = false,
    bypass = false,
    data = $bindable(),
  }: {
    admin?: boolean;
    children: Snippet;
    suspended?: boolean;
    bypass?: boolean;
    data: PageData;
  } = $props();
  /* eslint-enable prefer-const */
  let refreshError = $state('');
  onMount(() => {
    let active = true;
    const clear = setDashboardRefresh(async () => {
      try {
        const response = await fetch(`/api/settings${admin ? '?admin' : ''}`, {
          headers: { Accept: 'application/json' },
        });
        if (!response.ok || response.redirected)
          throw new Error(
            'Settings could not be refreshed. Your edits are still here. Try again when connected.',
          );
        const latest = await response.json<PageData>();
        if (!active) return;
        data = latest;
        dashboardSnapshot.set(data);
        refreshError = '';
      } catch (error) {
        if (active)
          refreshError =
            'Settings could not be refreshed. Your edits are still here. Try again when connected.';
        throw error;
      }
    });
    return () => {
      active = false;
      clear();
    };
  });
  const forms = $state<Record<string, { dirty: boolean; pending: boolean }>>(
    {},
  );
  const dirty = $derived(Object.values(forms).some((form) => form.dirty));
  const pending = $derived(Object.values(forms).some((form) => form.pending));
  let destination = $state<{ url: string; delta?: number } | null>(null);
  let discarding = false;
  setContext<SettingsState>(settingsContext, {
    update: (id, state) => (forms[id] = state),
    remove: (id) => delete forms[id],
  });
  beforeNavigate((navigation) => {
    if (
      bypass ||
      discarding ||
      !dirty ||
      navigation.willUnload ||
      navigation.to?.url.pathname === navigation.from?.url.pathname
    )
      return;
    navigation.cancel();
    if (navigation.to)
      destination = {
        url: navigation.to.url.href,
        ...(navigation.type === 'popstate' && { delta: navigation.delta }),
      };
  });
  async function discard() {
    const next = destination;
    destination = null;
    if (!next) return;
    discarding = true;
    if (next.delta) history.go(next.delta);
    else {
      try {
        await goto(next.url);
      } finally {
        discarding = false;
      }
    }
  }
  $effect(() =>
    watchRefresh(
      () => {
        void dashboard.refresh().catch(() => {});
      },
      () => !pending && !suspended && !destination && !navigating.to && !bypass,
      $uploads ? 5000 : null,
    ),
  );
</script>

<svelte:window
  onbeforeunload={(event: BeforeUnloadEvent) => {
    if (dirty && !bypass && !discarding) event.preventDefault();
  }}
/>
<div class="settings-page" class:settings-page-admin={admin}>
  <div class="settings-page-heading">
    <h1>Settings</h1>
  </div>
  <DashboardNotice {data} />
  {#if refreshError}<p class="settings-message notice" role="status">
      {refreshError}
      <button
        type="button"
        onclick={() => void dashboard.refresh().catch(() => {})}
        >Retry refresh</button
      >
    </p>{/if}
  {@render children()}
</div>
{#if destination}<Modal
    title="Discard unsaved changes?"
    onClose={() => (destination = null)}
  >
    <p>
      Your settings have not been saved. Stay here to keep editing, or discard
      your changes and leave.
    </p>
    <div class="settings-buttons">
      <button onclick={() => (destination = null)}>Keep editing</button>
      <button class="danger" onclick={discard}>Discard changes</button>
    </div>
  </Modal>{/if}
