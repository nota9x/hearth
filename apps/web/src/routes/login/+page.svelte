<script lang="ts">
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import KeyRound from '@lucide/svelte/icons/key-round';

  import { goto } from '$app/navigation';
  import Brand from '$lib/Brand.svelte';
  import { action } from '$lib/client';
  import { fadeMotion } from '$lib/motion';
  import { notify } from '$lib/notifications';
  import { clearOnboardingKey, holdOnboardingKey } from '$lib/onboarding-key';
  import Spinner from '$lib/Spinner.svelte';
  import Turnstile from '$lib/Turnstile.svelte';

  import type { PageProps as PageProperties } from './$types';

  const { data }: PageProperties = $props();
  let key = $state(''),
    token = $state(''),
    busy = $state(false),
    reset = $state(0);
  async function login(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    try {
      const result = await action<{ userId: string; destination: string }>(
        'login',
        { key, token },
      );
      clearOnboardingKey();
      if (result.destination === '/onboarding')
        holdOnboardingKey(result.userId, key);
      key = '';
      await goto(result.destination, { invalidateAll: true });
    } catch (error_) {
      notify.error(
        error_ instanceof Error ? error_.message : 'Could not sign in.',
      );
      token = '';
      reset++;
    } finally {
      busy = false;
    }
  }
</script>

<div class="auth">
  <Brand name={data.siteName} href="/login" />
  <h1>Sign in</h1>
  <form onsubmit={login}>
    <label
      ><KeyRound size={15} /> Your API key<input
        type="password"
        bind:value={key}
        placeholder="img_live_…"
        autocomplete="off"
        required
        maxlength="160"
        spellcheck="false"
      /></label
    >{#key reset}<Turnstile
        siteKey={data.siteKey}
        onToken={(v: string) => (token = v)}
      />{/key}<button class="primary full-width" disabled={busy || !token}
      >{busy ? 'Signing in…' : 'Sign in'}<span class="feedback-icon"
        >{#key busy}<span transition:fadeMotion
            >{#if busy}<Spinner size={17} />{:else}<ArrowRight
                size={17}
              />{/if}</span
          >{/key}</span
      ></button
    >
  </form>
  <div class="auth-footer">
    If you’ve lost your key, contact your administrator.
  </div>
</div>
