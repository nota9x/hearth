<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import { onMount } from 'svelte';

  import Brand from '#lib/Brand.svelte';
  import { action } from '#lib/client.ts';
  import { fadeMotion } from '#lib/motion.ts';
  import { notify } from '#lib/notifications.ts';
  import Spinner from '#lib/Spinner.svelte';
  import Turnstile from '#lib/Turnstile.svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';

  import type { PageProps as PageProperties } from './$types';

  const { data }: PageProperties = $props();
  let token = $state(''),
    verification = $state(''),
    busy = $state(false),
    error = $state(''),
    done = $state(false),
    filename = $state(''),
    reset = $state(0);
  onMount(() => {
    token = location.hash.slice(1);
    void goto(location.pathname, {
      replace: true,
      reset: false,
      state: page.state,
    })
      .then(() =>
        token
          ? action('delete-info', { imageId: page.params.id, token })
          : undefined,
      )
      .then((result) => {
        if (result) filename = String(result.filename);
      })
      .catch((error_) => {
        error =
          error_ instanceof Error ? error_.message : 'Invalid deletion link.';
        token = '';
      });
  });
  async function remove() {
    busy = true;
    error = '';
    try {
      await action('delete-token', {
        imageId: page.params.id,
        token,
        turnstile: verification,
      });
      token = '';
      done = true;
    } catch (error_) {
      notify.error(
        error_ instanceof Error ? error_.message : 'Deletion failed.',
      );
      verification = '';
      reset++;
    } finally {
      busy = false;
    }
  }
</script>

<div class="auth">
  <Brand name={data.siteName} href="/" />{#if done}<h1
      in:fadeMotion={{ kind: 'content' }}
    >
      Image removed
    </h1>
    <p in:fadeMotion={{ kind: 'content' }}>
      <Check size={24} /> All public links are now inactive.
    </p>{:else}<h1>Delete this image?</h1>
    {#if filename}<p in:fadeMotion={{ kind: 'content' }}>
        <strong>{filename}</strong>
      </p>{/if}
    <p>
      This permanently removes the image and invalidates all its public links.
      This action cannot be undone.
    </p>
    {#if error}<div
        transition:fadeMotion={{ kind: 'content' }}
        class="error"
        role="alert"
      >
        {error}
      </div>{/if}{#if !token}<p class="error">
        Open the full deletion URL saved in ShareX to continue.
      </p>{:else}{#key reset}<Turnstile
          siteKey={data.siteKey}
          action="delete"
          onToken={(v: string) => (verification = v)}
        />{/key}
      <div class="dialog-actions">
        <a href="/login" class="button">Cancel</a><button
          class="danger"
          onclick={remove}
          disabled={busy || !verification}
          ><span class="feedback-icon"
            >{#key busy}<span transition:fadeMotion
                >{#if busy}<Spinner size={17} />{:else}<Trash2
                    size={17}
                  />{/if}</span
              >{/key}</span
          >{busy ? 'Deleting…' : 'Delete image'}</button
        >
      </div>{/if}{/if}
</div>
