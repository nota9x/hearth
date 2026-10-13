<script lang="ts">
  import Download from '@lucide/svelte/icons/download';
  import { onDestroy, type Snippet } from 'svelte';

  import { action, ActionError, downloadConfig } from '$lib/client';
  import Spinner from '$lib/Spinner.svelte';

  /* eslint-disable prefer-const -- Reactive callbacks share the single Svelte props declaration with bindable state. */
  let {
    key = $bindable(''),
    busy = $bindable(false),
    onDownload,
    onExpired,
    field,
  }: {
    key?: string;
    busy?: boolean;
    onDownload?: () => void;
    onExpired?: () => void;
    field?: Snippet<[string, Snippet]>;
  } = $props();
  /* eslint-enable prefer-const */
  let error = $state('');
  let request: AbortController | undefined;
  const id = $props.id();
  $effect(() => {
    if (!key) request?.abort();
  });
  onDestroy(() => request?.abort());
  async function download(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    busy = true;
    error = '';
    request = new AbortController();
    try {
      const config = await action('sxcu', { key }, request.signal);
      if (request.signal.aborted) return;
      downloadConfig(config);
      onDownload?.();
    } catch (error_) {
      error = request.signal.aborted
        ? 'Enter your current API key to try again.'
        : error_ instanceof Error
          ? error_.message
          : 'Could not download. Please try again.';
      if (error_ instanceof ActionError && error_.status === 401) {
        key = '';
        if (error_.code === 'UNAUTHENTICATED') onExpired?.();
      }
    } finally {
      busy = false;
      request = undefined;
    }
  }
</script>

{#snippet credential()}
  <input
    {id}
    type="password"
    bind:value={key}
    disabled={busy}
    required
    autocomplete="off"
    maxlength="160"
    spellcheck="false"
    aria-describedby={error ? 'sxcu-privacy sxcu-error' : 'sxcu-privacy'}
    aria-invalid={!!error}
  />
{/snippet}
<form
  onsubmit={download}
  class="sharex-config"
  style:container-type={field ? 'inline-size' : undefined}
>
  {#if field}{@render field(id, credential)}{:else}<label
      >Current API key{@render credential()}</label
    >{/if}
  <p id="sxcu-privacy">
    The configuration contains your API key. Keep the file private.
  </p>
  {#if error}<p id="sxcu-error" class="error" role="alert">{error}</p>{/if}
  <button class="primary" disabled={busy}
    >{#if busy}<Spinner size={18} />{:else}<Download size={18} />{/if}{busy
      ? 'Preparing configuration…'
      : 'Download ShareX configuration'}</button
  >
</form>

<style>
  .sharex-config {
    display: grid;
    gap: 16px;
  }
  p {
    font-size: 0.8rem;
    margin: 0;
  }
  button {
    justify-self: start;
  }
</style>
