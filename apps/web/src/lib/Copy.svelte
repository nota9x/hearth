<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import Copy from '@lucide/svelte/icons/copy';
  import { onDestroy } from 'svelte';

  import { fadeMotion } from '$lib/motion';

  import { copyText } from './clipboard';

  const {
    text,
    label = 'Copy link',
    compact = false,
    showLabel = false,
    disabled = false,
    oncopy,
  }: {
    text: string;
    label?: string;
    compact?: boolean;
    showLabel?: boolean;
    disabled?: boolean;
    oncopy?: () => void;
  } = $props();
  let copied = $state(false);
  let confirmation: ReturnType<typeof setTimeout>;
  let disposed = false;
  onDestroy(() => {
    disposed = true;
    clearTimeout(confirmation);
  });
  async function copy() {
    if (
      !(await copyText(
        text,
        label === 'Copy link' ? 'Link copied' : 'Copied',
      )) ||
      disposed
    )
      return;
    clearTimeout(confirmation);
    copied = true;
    oncopy?.();

    confirmation = setTimeout(() => (copied = false), 1600);
  }
</script>

<button
  class:icon-button={!showLabel}
  class:compact
  type="button"
  {disabled}
  onclick={copy}
  aria-label={copied ? 'Copied' : label}
  title={copied ? 'Copied' : label}
  ><span class="feedback-icon"
    >{#key copied}<span transition:fadeMotion
        >{#if copied}<Check size={showLabel ? 16 : 17} />{:else}<Copy
            size={showLabel ? 16 : 17}
          />{/if}</span
      >{/key}</span
  >{#if showLabel}{copied ? 'Copied' : label}{/if}</button
>
