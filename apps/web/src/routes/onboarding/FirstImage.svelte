<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import CircleHelp from '@lucide/svelte/icons/circle-help';
  import Image from '@lucide/svelte/icons/image';
  import { onMount, untrack } from 'svelte';
  import { z } from 'zod';

  import { action } from '$lib/client';
  import Spinner from '$lib/Spinner.svelte';

  type Status = 'waiting' | 'verified' | 'skipped' | null;
  const {
    initialStatus,
    initialImageId,
    onChange,
    onExpired,
  }: {
    initialStatus: Status;
    initialImageId: string | null;
    onChange: (status: Status, imageId: string | null) => void;
    onExpired: () => void;
  } = $props();

  let status = $state(untrack(() => initialStatus));
  let imageId = $state(untrack(() => initialImageId));
  let preparing = $state(false);
  let checking = $state(false);
  let troubleshooting = $state(false);
  let connectionError = $state(false);
  let stopped = $state(false);
  let previewFailed = $state(false);
  let active = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;
  let watchStarted = 0;
  let failures = 0;

  function update(next: Status, id: string | null) {
    status = next;
    imageId = id;
    onChange(next, id);
  }

  function schedule(delay: number) {
    clearTimeout(timer);
    if (active && document.visibilityState === 'visible')
      timer = setTimeout(() => void check(), delay);
  }

  async function check() {
    if (!active || checking || status !== 'waiting') return;
    if (Date.now() - watchStarted >= 120_000) {
      stopped = true;
      checking = false;
      return;
    }
    request = new AbortController();
    checking = true;
    try {
      const response = await fetch('/api/onboarding/first-image', {
        signal: request.signal,
        cache: 'no-store',
      });
      if (response.status === 401) {
        onExpired();
        return;
      }
      if (!response.ok) throw new Error('Could not check the upload.');
      const result = z
        .object({
          status: z.enum(['waiting', 'verified', 'skipped']).nullable(),
          imageId: z.string().nullable(),
        })
        .parse(await response.json());
      if (!active) return;
      connectionError = false;
      failures = 0;
      update(result.status, result.imageId);
      if (result.status !== 'waiting') return;
    } catch {
      if (!active || request.signal.aborted) return;
      connectionError = true;
      failures++;
    } finally {
      checking = false;
      request = undefined;
    }
    if (!active) return;
    troubleshooting ||= Date.now() - watchStarted >= 45_000;
    const delay = connectionError
      ? Math.min(30_000, 5000 * 2 ** Math.min(failures - 1, 3))
      : 5000;
    schedule(delay);
  }

  function begin() {
    stopped = false;
    connectionError = false;
    failures = 0;
    watchStarted = Date.now();
    if (document.visibilityState === 'visible') void check();
  }

  async function arm() {
    if (preparing) return;
    preparing = true;
    connectionError = false;
    request = new AbortController();
    try {
      const result = await action<{ status: Status; imageId: string | null }>(
        'onboarding-upload-arm',
        {},
        request.signal,
      );
      if (!active) return;
      update(result.status, result.imageId);
      if (result.status === 'waiting') begin();
    } catch (error) {
      if (!active || request.signal.aborted) return;
      connectionError = true;
      if (error instanceof Error && 'status' in error && error.status === 401)
        onExpired();
    } finally {
      preparing = false;
      request = undefined;
    }
  }

  function visibility() {
    if (document.visibilityState !== 'visible') {
      clearTimeout(timer);
      return;
    }
    if (status === 'waiting' && !stopped) schedule(0);
  }

  onMount(() => {
    active = true;
    document.addEventListener('visibilitychange', visibility);
    if (status === 'waiting') begin();
    else if (status !== 'verified') void arm();
    return () => {
      active = false;
      clearTimeout(timer);
      request?.abort();
      document.removeEventListener('visibilitychange', visibility);
    };
  });
</script>

<div class="first-image" class:done={status === 'verified'}>
  {#if status === 'verified'}
    <div class="milestone-icon success" aria-hidden="true">
      <Check size={42} />
    </div>
    <div class="milestone-copy" role="status">
      <h2>Your first image is ready.</h2>
      <p>Hearth received a new image through your uploader connection.</p>
    </div>
    {#if imageId && !previewFailed}
      <div class="preview">
        <img
          src={`/api/media/${encodeURIComponent(imageId)}?preview`}
          alt="Your uploaded screenshot"
          onerror={() => (previewFailed = true)}
        />
      </div>
    {:else}
      <p class="preview-fallback">
        <Image size={18} />The preview is unavailable, but your image was saved.
      </p>
    {/if}
  {:else}
    <div class="milestone-icon" aria-hidden="true">
      {#if status === 'waiting' && !stopped}<Spinner size={44} />{:else}<Image
          size={28}
        />{/if}
    </div>
    <div class="milestone-copy" role="status">
      <h2>
        {status === 'skipped'
          ? 'This check was skipped.'
          : 'Waiting for your first image…'}
      </h2>
      <p>
        Open ShareX and take a screenshot with your configured shortcut. If
        automatic upload is enabled, ShareX will send it to Hearth.
      </p>
    </div>
    {#if connectionError}<p class="connection-note">
        Connection interrupted. Hearth will try again when it can.
      </p>{/if}
    {#if troubleshooting || stopped || status === 'skipped'}
      <details class="troubleshooting" open={stopped}>
        <summary><CircleHelp size={16} />Having trouble?</summary>
        <p>
          In ShareX, check that Hearth is the active image destination, “Upload
          image to host” is enabled, and the imported configuration uses your
          current API key. Check ShareX’s upload history for an error, then try
          another screenshot.
        </p>
      </details>
    {/if}
    {#if stopped || status === 'skipped' || (connectionError && status === null)}
      <button
        class="retry"
        type="button"
        disabled={preparing}
        onclick={() =>
          status === 'skipped' || status === null ? void arm() : begin()}
      >
        {preparing ? 'Starting check…' : 'Check again'}
      </button>
    {/if}
  {/if}
</div>

<style>
  .first-image {
    min-height: 380px;
    padding: clamp(25px, 4vw, 42px);
    border: 1px solid #e8d5bc28;
    border-radius: 26px;
    background: radial-gradient(ellipse at 50% 0%, #c4714a18, #1e1b18 66%);
    box-shadow: 0 24px 64px #09070524;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }
  .first-image.done {
    background: radial-gradient(ellipse at 50% 0%, #b8bf961b, #1e1b18 70%);
  }
  .milestone-icon {
    width: 78px;
    height: 78px;
    margin: 5px 0 24px;
    display: grid;
    place-items: center;
    color: #e1a77e;
  }
  .milestone-icon.success {
    color: #d8e0ae;
    animation: arrive 380ms var(--motion-enter) both;
  }
  .milestone-copy h2 {
    margin: 0;
    font-size: clamp(1.35rem, 2.4vw, 1.8rem);
    font-weight: 500;
    letter-spacing: -0.025em;
  }
  .milestone-copy p {
    max-width: 350px;
    margin: 12px auto 0;
    color: #b9a997;
    font-size: 0.82rem;
    line-height: 1.7;
  }
  .connection-note,
  .preview-fallback {
    color: #dfbc88;
    font-size: 0.73rem;
    line-height: 1.6;
  }
  .troubleshooting {
    width: 100%;
    max-width: 380px;
    margin-top: 20px;
    text-align: left;
    border-top: 1px solid var(--border);
    padding-top: 16px;
    color: var(--muted);
    font-size: 0.72rem;
  }
  .troubleshooting summary {
    display: flex;
    align-items: center;
    gap: 8px;
    width: fit-content;
    cursor: pointer;
    color: #d2b899;
  }
  .troubleshooting p {
    line-height: 1.7;
  }
  .retry {
    margin-top: 18px;
    min-height: 40px;
  }
  .preview {
    width: 100%;
    height: 190px;
    margin-top: 24px;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 15px;
    background: #141210;
  }
  .preview img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .preview-fallback {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 24px;
  }
  @keyframes arrive {
    from {
      opacity: 0;
      transform: scale(0.9);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .milestone-icon.success {
      animation: none;
    }
    :global(.first-image .loading-spinner) {
      animation: none;
    }
  }
</style>
