<script lang="ts">
  import { usersURL } from '@hearth/core/user-search';
  import { onDestroy } from 'svelte';

  import { beforeNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import { fadeMotion } from '$lib/motion';

  import type { PageData } from '../routes/[...path]/$types';
  import { action, ActionError } from './client';
  import Copy from './Copy.svelte';
  import { dashboard } from './dashboard';
  import Modal from './Modal.svelte';
  import { notify } from './notifications';
  import Turnstile from './Turnstile.svelte';

  /* eslint-disable prefer-const -- Bindable Svelte props must be mutable. */
  let {
    data,
    busy = $bindable(false),
    modal = $bindable(''),
  }: { data: PageData; busy?: boolean; modal?: string } = $props();
  /* eslint-enable prefer-const */
  let error = $state(''),
    target = $state(''),
    token = $state(''),
    secret = $state('');
  let displayName = $state(''),
    role = $state('user'),
    revoked = $state(false);
  let selectedFindings = $state<PageData['findings']>([]);
  let resolvedCount = $state(0);
  let attemptedCount = $state(0);
  let stopped = $state(false);
  let waiting = $state(false);
  let failures = $state<{ id: string; name: string; message: string }[]>([]);
  let resumeBulk: (() => void) | undefined;
  const deletions = $derived(
    selectedFindings.filter((entry) => entry.kind === 'orphan').length,
  );
  const retirements = $derived(
    selectedFindings.filter((entry) => entry.kind === 'missing').length,
  );
  const repairs = $derived(selectedFindings.length - deletions - retirements);
  function stopBulk() {
    stopped = true;
    resumeBulk?.();
  }
  onDestroy(stopBulk);
  beforeNavigate(({ from, to }) => {
    if (modal !== 'findings' || from?.url.pathname === to?.url.pathname) {
      return;
    }

    stopBulk();
    modal = '';
  });
  async function resolveFinding(id: string) {
    while (!stopped) {
      try {
        return await action('finding-resolve', { id });
      } catch (error_) {
        if (!(error_ instanceof ActionError) || error_.status !== 429)
          throw error_;
        waiting = true;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 60_000);
          resumeBulk = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        resumeBulk = undefined;
        waiting = false;
      }
    }
    return null;
  }
  async function resolveAll() {
    const selected = [...selectedFindings];
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Local bookkeeping is not rendered.
    const resolved = new Set<string>();
    resolvedCount = 0;
    attemptedCount = 0;
    stopped = false;
    failures = [];
    let cleanupPending = false;
    for (const entry of selected) {
      if (stopped) break;
      try {
        const result = await resolveFinding(entry.id);
        if (!result) break;
        resolved.add(entry.id);
        resolvedCount = resolved.size;
        cleanupPending ||= Boolean(result.cleanupPending);
      } catch (error_) {
        failures.push({
          id: entry.id,
          name: entry.objectKey ?? entry.id,
          message:
            error_ instanceof Error
              ? error_.message
              : 'Could not resolve this issue.',
        });
        if (
          !(error_ instanceof ActionError) ||
          error_.status >= 500 ||
          [401, 403].includes(error_.status)
        )
          stopped = true;
      }
      attemptedCount++;
    }
    selectedFindings = selected.filter((entry) => !resolved.has(entry.id));
    await dashboard.refresh(true);
    if (modal !== 'findings') return;
    if (selectedFindings.length > 0) {
      error = `${resolved.size} resolved. ${selectedFindings.length} ${selectedFindings.length === 1 ? 'issue remains' : 'issues remain'}${stopped ? ' after stopping' : ''}. Review the remaining issues before trying again.`;
    } else {
      notify.success(
        cleanupPending
          ? 'All listed storage issues resolved. Physical cleanup is queued for maintenance.'
          : 'All listed storage issues resolved.',
      );
      modal = '';
    }
  }
  const finding = $derived(data.findings.find((entry) => entry.id === target));
  const findingAction = $derived(
    finding?.kind === 'orphan'
      ? 'Permanently delete file'
      : finding?.kind === 'missing'
        ? 'Retire missing image'
        : 'Repair storage accounting',
  );

  export function open(name: string, id = '') {
    error = '';
    target = id;
    token = '';
    secret = '';
    displayName = '';
    role = 'user';
    selectedFindings = name === 'findings' ? [...data.findings] : [];
    failures = [];
    resolvedCount = 0;
    attemptedCount = 0;
    stopped = false;
    waiting = false;
    modal = name;
  }
  function close() {
    if (busy) return;
    modal = '';
    secret = '';
    if (revoked) void goto('/login', { invalidateAll: true });
  }
  async function confirm() {
    busy = true;
    error = '';
    try {
      if (modal === 'user-delete') {
        await action('user-delete', { userId: target, token });
        notify.success('Account removed. Stored files are queued for cleanup.');
        modal = '';
        await goto(target === data.user.id ? '/login' : usersURL(page.url), {
          invalidateAll: true,
        });
        return;
      }
      if (modal === 'findings') {
        await resolveAll();
        return;
      }
      if (modal === 'finding') {
        const result = await action('finding-resolve', { id: target });
        await dashboard.refresh(true);
        notify.success(
          result.cleanupPending
            ? 'Image retired. Physical cleanup is queued for maintenance.'
            : 'Storage issue resolved.',
        );
        modal = '';
        return;
      }
      const result =
        modal === 'invite'
          ? await action('user-create', { displayName, role, token })
          : await action('user-reset', { userId: target, token });
      revoked = modal === 'user-reset' && target === data.user.id;
      secret = String(result.key);
      const message =
        modal === 'invite' ? 'Invitation created.' : 'Changes saved.';
      modal = 'new-key';
      if (!revoked) await dashboard.refresh(true);
      notify.success(message);
    } catch (error_) {
      error = error_ instanceof Error ? error_.message : 'Please try again.';
    } finally {
      busy = false;
    }
  }
</script>

{#if modal}
  <Modal
    title={modal === 'new-key'
      ? 'Save your API key'
      : modal === 'invite'
        ? 'Invite user'
        : modal === 'user-delete'
          ? 'Delete user'
          : modal === 'findings'
            ? 'Resolve all storage issues'
            : modal === 'finding'
              ? findingAction
              : 'Reset credential'}
    onClose={close}
    {busy}
  >
    {#if error}<p
        transition:fadeMotion={{ kind: 'content' }}
        class="error"
        role="alert"
      >
        {error}
      </p>{/if}
    {#if modal === 'new-key'}
      <p>This key is shown once. Save it before closing this window.</p>
      <div class="secret">{secret}</div>
      <div class="toolbar"><Copy text={secret} label="Copy API key" /></div>
      <button onclick={close}>I’ve saved it</button>
    {:else}
      <form
        class="form-grid"
        onsubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
      >
        {#if modal === 'user-delete'}<p>
            This revokes account access and all public links immediately. Image
            bytes are permanently deleted by cleanup.
          </p>{/if}
        {#if modal === 'findings'}
          <p>
            Resolve all {selectedFindings.length} listed issues across every page.
            Hearth checks each issue against current storage before acting.
          </p>
          <ul class="resolution-summary">
            {#if deletions}<li>
                Permanently delete {deletions} untracked {deletions === 1
                  ? 'file'
                  : 'files'}. This cannot be undone.
              </li>{/if}
            {#if retirements}<li>
                Retire {retirements} missing {retirements === 1
                  ? 'image'
                  : 'images'} and disable their links. Remaining files are queued
                for cleanup.
              </li>{/if}
            {#if repairs}<li>
                Verify or repair {repairs} storage accounting {repairs === 1
                  ? 'issue'
                  : 'issues'}.
              </li>{/if}
          </ul>
          {#if busy}<p role="status">
              {waiting
                ? 'Rate limit reached. Continuing in one minute…'
                : `Checked ${attemptedCount} of ${selectedFindings.length} issues · ${resolvedCount} resolved`}
            </p>{/if}
          {#if failures.length}<ul class="resolution-failures">
              {#each failures as failure (failure.id)}<li>
                  <code>{failure.name}</code><span>{failure.message}</span>
                </li>{/each}
            </ul>{/if}
        {/if}
        {#if modal === 'finding'}<p>
            {finding?.kind === 'orphan'
              ? 'This permanently deletes the untracked file from R2. It cannot be undone. Hearth will check that no image or active upload references it before deletion.'
              : finding?.kind === 'missing'
                ? 'The original file is missing. This retires its image record and disables its links. Remaining physical files are cleaned up before capacity is released.'
                : 'Hearth will verify current storage or recalculate the affected counters. Existing original images are preserved.'}
          </p>
          <code style="overflow-wrap:anywhere"
            >{finding?.objectKey ?? finding?.details}</code
          >{/if}
        {#if modal === 'invite'}
          <label
            >Display name<input
              bind:value={displayName}
              required
              maxlength="80"
            /></label
          >
          <label
            >Role<select bind:value={role}
              ><option value="user">Member</option><option value="admin"
                >Administrator</option
              ></select
            ></label
          >
        {/if}
        {#if modal !== 'finding' && modal !== 'findings'}<Turnstile
            siteKey={data.siteKey}
            action="sensitive"
            onToken={(value: string) => (token = value)}
          />{/if}
        <div class="dialog-actions">
          <button
            type="button"
            onclick={busy && modal === 'findings' ? stopBulk : close}
            disabled={busy && (modal !== 'findings' || stopped)}
            >{busy && modal === 'findings'
              ? 'Stop after current issue'
              : 'Cancel'}</button
          >
          <button
            class:danger={modal === 'findings'
              ? deletions + retirements > 0
              : modal !== 'invite' &&
                (modal !== 'finding' ||
                  ['orphan', 'missing'].includes(finding?.kind ?? ''))}
            class:primary={modal === 'invite' ||
              (modal === 'findings' && deletions + retirements === 0)}
            disabled={busy ||
              (modal !== 'finding' && modal !== 'findings' && !token)}
            >{busy
              ? 'Working…'
              : modal === 'invite'
                ? 'Create invitation'
                : modal === 'findings'
                  ? 'Resolve all issues'
                  : modal === 'finding'
                    ? findingAction
                    : 'Confirm'}</button
          >
        </div>
      </form>
    {/if}
  </Modal>
{/if}

<style>
  .resolution-summary {
    padding-left: 1.25rem;
    margin: 0;
    display: grid;
    gap: 0.75rem;
  }
  .resolution-failures {
    padding: 0;
    margin: 0;
    list-style: none;
    display: grid;
    gap: 1rem;
    max-height: 16rem;
    overflow: auto;
  }
  .resolution-failures li {
    display: grid;
    gap: 0.35rem;
    overflow-wrap: anywhere;
  }
  .resolution-failures span {
    color: var(--danger);
    font-size: 0.85rem;
  }
</style>
