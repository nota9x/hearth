<script lang="ts">
  import {
    defaultExpiryError,
    type EffectiveExpiryPolicy,
    formatLifetime,
  } from '@hearth/core/expiry-policy';
  import Image from '@lucide/svelte/icons/image';
  import ImageUp from '@lucide/svelte/icons/image-up';
  import { onMount } from 'svelte';

  import { fadeMotion } from '#lib/motion.ts';

  import { dashboard } from './dashboard';
  import { listenForFileDrop } from './file-drop';
  import { uploads } from './uploads';

  const {
    defaultExpiry,
    policy,
  }: { defaultExpiry: string; policy: EffectiveExpiryPolicy } = $props();
  const invalidDefault = $derived(defaultExpiryError(policy, defaultExpiry));

  let active = $state(false);
  onMount(() =>
    listenForFileDrop(
      (value) => (active = value),
      (files) => {
        void uploads.start(files, () => dashboard.refresh(true));
      },
    ),
  );
</script>

<div role="status" aria-live="polite" aria-atomic="true">
  {#if active}
    <div class="file-drop-overlay" transition:fadeMotion={{ kind: 'content' }}>
      <div class="file-drop-card">
        <div class="file-drop-icons" aria-hidden="true">
          <Image size={64} /><ImageUp size={88} />
        </div>
        <h2>Release to upload</h2>
        <p>PNG, JPEG, GIF, WebP or AVIF</p>
        {#if invalidDefault}<p class="error">
            Update your default image expiry in Settings before uploading.
          </p>
        {:else if policy.requireExpiry || policy.maxLifetimeSeconds !== null}<p>
            Expiry is required.{policy.maxLifetimeSeconds === null
              ? ''
              : ` Maximum lifetime: ${formatLifetime(policy.maxLifetimeSeconds)}.`}
          </p>{/if}
      </div>
    </div>
  {/if}
</div>
