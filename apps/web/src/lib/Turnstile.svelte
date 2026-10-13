<script lang="ts">
  import { onMount } from 'svelte';

  import { fadeMotion } from '#lib/motion.ts';

  const {
    siteKey,
    action = 'login',
    onToken,
  }: {
    siteKey: string;
    action?: string;
    onToken: (token: string) => void;
  } = $props();
  let container: HTMLDivElement;
  let failed = $state(false);
  type Widget = {
    render: (element: HTMLElement, options: Record<string, unknown>) => string;
    remove: (id: string) => void;
  };
  const getWidget = () =>
    Reflect.get(globalThis, 'turnstile') as Widget | undefined;
  onMount(() => {
    let widgetId: string | undefined;
    let cancelled = false;
    const render = () => {
      const widget = getWidget();
      if (widget && !cancelled)
        widgetId = widget.render(container, {
          sitekey: siteKey,
          action,
          theme: 'dark',
          callback: (token: string) => {
            failed = false;
            onToken(token);
          },
          'expired-callback': () => onToken(''),
          'error-callback': () => {
            failed = true;
            onToken('');
          },
        });
    };
    let script = document.querySelector<HTMLScriptElement>(
      'script[data-turnstile]',
    );
    if (getWidget()) render();
    else if (script) script.addEventListener('load', render, { once: true });
    else {
      script = document.createElement('script');
      script.src =
        'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.dataset.turnstile = 'true';
      script.async = true;
      script.addEventListener('load', render, { once: true });
      script.addEventListener(
        'error',
        () => {
          if (!cancelled) failed = true;
        },
        { once: true },
      );
      // eslint-disable-next-line unicorn/prefer-dom-node-append -- Workers and DOM Element.append declarations conflict.
      document.head.appendChild(script);
    }
    return () => {
      cancelled = true;
      if (widgetId) getWidget()?.remove(widgetId);
    };
  });
</script>

<div
  bind:this={container}
  class="turnstile"
  aria-label="Security verification"
></div>
{#if failed}<p
    transition:fadeMotion={{ kind: 'content' }}
    class="error"
    role="alert"
  >
    Security verification could not load. Check your connection or content
    blocker, then reload this page.
  </p>{/if}
