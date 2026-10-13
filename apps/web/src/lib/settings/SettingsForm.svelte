<script lang="ts">
  import { onDestroy, type Snippet } from 'svelte';

  import Spinner from '#lib/Spinner.svelte';

  import { settingsState } from './settings';

  /* eslint-disable prefer-const -- Bindable props share one Svelte declaration. */
  let {
    dirty,
    invalid = false,
    saveLabel,
    save,
    reset,
    children,
    pending = $bindable(false),
  }: {
    dirty: boolean;
    invalid?: boolean;
    saveLabel: string;
    save: () => Promise<string | void>;
    reset: () => void;
    children: Snippet;
    pending?: boolean;
  } = $props();
  /* eslint-enable prefer-const */
  const id = $props.id();
  const registry = settingsState();
  let error = $state('');
  let saved = $state(false);
  let warning = $state('');
  let form: HTMLFormElement;
  let nativeInvalid = $state(false);
  function validate() {
    nativeInvalid = form.matches(':invalid');
  }
  $effect(() => {
    if (dirty && !pending && !invalid)
      nativeInvalid = form?.matches(':invalid') ?? false;
  });
  $effect(() => registry.update(id, { dirty, pending }));
  onDestroy(() => registry.remove(id));

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (pending || !dirty || invalid || nativeInvalid) return;
    pending = true;
    error = warning = '';
    saved = false;
    try {
      warning = (await save()) ?? '';
      saved = true;
    } catch (error_) {
      error =
        error_ instanceof Error
          ? error_.message
          : 'Could not save. Please try again.';
    } finally {
      pending = false;
    }
  }
</script>

<form
  bind:this={form}
  oninput={validate}
  onchange={validate}
  onsubmit={submit}
  class="settings-form"
  aria-busy={pending}
>
  <fieldset disabled={pending}>
    {@render children()}
  </fieldset>
  <div class="settings-actions">
    <div class="settings-status" role="status" aria-live="polite">
      {#if pending}<Spinner size={15} />Saving…
      {:else if dirty}Unsaved changes
      {:else if saved}<span class="settings-saved">Saved</span>{/if}
    </div>
    <div class="settings-buttons">
      {#if dirty}<button
          type="button"
          disabled={pending}
          onclick={() => {
            reset();
            error = warning = '';
            saved = false;
          }}>Reset</button
        >{/if}
      <button
        class="primary"
        disabled={pending || !dirty || invalid || nativeInvalid}
      >
        {pending ? 'Saving…' : saveLabel}
      </button>
    </div>
  </div>
  {#if error}<p class="settings-message error" role="alert">{error}</p>{/if}
  {#if warning}<p class="settings-message notice" role="status">
      {warning}
    </p>{/if}
</form>
