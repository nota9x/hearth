<script lang="ts">
  import { pageURL, pageWindow } from '@hearth/core/search';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';

  import { goto } from '$app/navigation';
  import { navigating, page } from '$app/state';

  const {
    current,
    pages,
    total,
    size,
    parameter = 'page',
    onchange,
    busy = false,
  }: {
    current: number;
    pages: number;
    total: number;
    size: number;
    parameter?: string;
    onchange?: (page: number) => void;
    busy?: boolean;
  } = $props();
</script>

<nav
  class="result-pagination"
  aria-label="Pagination"
  aria-busy={busy || !!navigating.to}
>
  <span class="page-status"
    >Page {current} of {pages}&nbsp;·&nbsp;{total
      ? (current - 1) * size + 1
      : 0}–{Math.min(current * size, total)} of {total}</span
  >
  <div class="page-links">
    {#if current > 1}<a
        class="button icon-button"
        href={pageURL(new URL(page.url.href), current - 1, parameter)}
        onclick={(event) => {
          if (!onchange) {
            return;
          }

          event.preventDefault();
          if (!busy) onchange(current - 1);
        }}
        rel="prev"
        aria-label="Previous page"
        title="Previous page"><ChevronLeft size={18} aria-hidden="true" /></a
      >{:else}<span
        class="button icon-button"
        aria-disabled="true"
        aria-label="Previous page"
        ><ChevronLeft size={18} aria-hidden="true" /></span
      >{/if}
    {#each pageWindow(current, pages) as item (item)}
      {#if typeof item === 'number'}<a
          class="button page-number"
          href={pageURL(new URL(page.url.href), item, parameter)}
          onclick={(event) => {
            if (!onchange) {
              return;
            }

            event.preventDefault();
            if (!busy) onchange(item);
          }}
          aria-label={`Page ${item}`}
          aria-current={item === current ? 'page' : undefined}>{item}</a
        >{:else}<span aria-hidden="true">…</span>{/if}
    {/each}
    {#if current < pages}<a
        class="button icon-button"
        href={pageURL(new URL(page.url.href), current + 1, parameter)}
        onclick={(event) => {
          if (!onchange) {
            return;
          }

          event.preventDefault();
          if (!busy) onchange(current + 1);
        }}
        rel="next"
        aria-label="Next page"
        title="Next page"><ChevronRight size={18} aria-hidden="true" /></a
      >{:else}<span
        class="button icon-button"
        aria-disabled="true"
        aria-label="Next page"
        ><ChevronRight size={18} aria-hidden="true" /></span
      >{/if}
  </div>
  {#if pages > 7}<form
      onsubmit={(event) => {
        event.preventDefault();
        const input = new FormData(event.currentTarget).get('page');
        const target = Math.min(
          pages,
          Math.max(1, Math.floor(Number(input)) || 1),
        );
        if (onchange) onchange(target);
        else void goto(pageURL(new URL(page.url.href), target, parameter));
      }}
    >
      <label
        >Go to page<input
          type="number"
          name="page"
          min="1"
          max={pages}
          value={current}
          required
        /></label
      ><button type="submit">Go</button>
    </form>{/if}
</nav>

<style>
  .result-pagination {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    margin-top: 1.5rem;
  }
  .page-status {
    flex-basis: 100%;
    text-align: center;
    color: var(--muted);
    font-size: 0.85rem;
  }
  .page-links {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
  }
  .page-number {
    min-width: 2.75rem;
    padding: 0.5rem;
  }
  [aria-current='page'] {
    --control-hover: #d88960;
    --control-pressed: color-mix(in srgb, var(--control-hover) 94%, white);
    background: var(--accent);
    color: var(--page);
    border-color: transparent;
  }
  [aria-current='page']:hover {
    background: var(--control-hover);
  }
  [aria-current='page']:active {
    background: var(--control-pressed);
  }
  [aria-disabled='true'] {
    opacity: 0.45;
  }
  form,
  label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  input {
    width: 5rem;
    margin: 0;
  }
  @media (max-width: 480px) {
    .page-links {
      gap: 0.25rem;
    }
    .page-links .button {
      min-width: 2rem;
      padding: 0.45rem;
      font-size: 0.8rem;
    }
  }
</style>
