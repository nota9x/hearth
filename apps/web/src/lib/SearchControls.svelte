<script lang="ts">
  import {
    dateOptions,
    dateRange,
    type SearchFilter,
    searchText,
    searchURL,
  } from '@hearth/core/search';
  import ArrowUpDown from '@lucide/svelte/icons/arrow-up-down';
  import ListFilter from '@lucide/svelte/icons/list-filter';
  import Search from '@lucide/svelte/icons/search';
  import X from '@lucide/svelte/icons/x';
  import { onDestroy, onMount, untrack } from 'svelte';

  import { fadeMotion } from '#lib/motion.ts';
  import { notify } from '#lib/notifications.ts';
  import { afterNavigate, beforeNavigate, goto } from '$app/navigation';
  import { navigating, page } from '$app/state';

  const {
    total,
    unfilteredTotal,
    noun,
    plural,
    dateLabel = 'Date',
    filters = [],
    sortOptions,
    querySort = 'newest',
    timeZoneFilters = [],
  }: {
    total: number;
    unfilteredTotal: number;
    noun: string;
    plural: string;
    dateLabel?: string;
    filters?: SearchFilter[];
    sortOptions: Record<string, string>;
    querySort?: string;
    timeZoneFilters?: string[];
  } = $props();
  const filterKeys = $derived([
    'date',
    'from',
    'to',
    ...filters.map((filter) => filter.key),
  ]);
  let query = $state(untrack(() => page.url.searchParams.get('q') || ''));
  let values = $state<Record<string, string>>(
    untrack(() => Object.fromEntries(page.url.searchParams)),
  );
  let input: HTMLInputElement;
  let sortPanel: HTMLDetailsElement;
  let filterPanel: HTMLDetailsElement;
  let sortOpen = $state(false);
  let filterOpen = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let composing = false;
  let requestedURL = '';
  const active = $derived(
    filterKeys.filter((key) => key !== 'from' && key !== 'to' && values[key]),
  );
  const text = $derived(searchText(query));
  const sort = $derived(
    values.sort
      ? Object.hasOwn(sortOptions, values.sort) &&
        (values.sort !== 'best' || text)
        ? values.sort
        : 'newest'
      : text
        ? querySort
        : 'newest',
  );

  beforeNavigate(({ type, to }) => {
    if (type !== 'goto' || to?.url.href !== requestedURL) clearTimeout(timer);
  });
  afterNavigate(({ type, to }) => {
    if (type === 'goto' && to?.url.href === requestedURL) {
      return;
    }

    clearTimeout(timer);
    query = page.url.searchParams.get('q') || '';
    values = Object.fromEntries(page.url.searchParams);
  });
  onDestroy(() => clearTimeout(timer));
  onMount(() => {
    if (
      (values.date ||
        timeZoneFilters.some((key) => values[key]) ||
        dateRange(query.trim().toLowerCase())) &&
      page.url.searchParams.get('tz') !==
        new Intl.DateTimeFormat().resolvedOptions().timeZone
    )
      void update(true);
  });

  async function update(replaceState = false) {
    clearTimeout(timer);
    const url = searchURL(
      new URL(page.url.href),
      values,
      query,
      filterKeys,
      new Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    if (timeZoneFilters.some((key) => values[key]))
      url.searchParams.set(
        'tz',
        new Intl.DateTimeFormat().resolvedOptions().timeZone,
      );
    if (!text && values.sort === 'best') url.searchParams.delete('sort');
    if (url.href === page.url.href && !navigating.to) return;
    try {
      // SvelteKit cancels superseded navigations; previous data stays rendered.
      requestedURL = url.href;
      await goto(url, { reset: false, replace: replaceState });
    } catch {
      notify.error('Search could not update. Please try again.');
    }
  }
  function queueUpdate() {
    clearTimeout(timer);
    if (!composing) timer = setTimeout(() => void update(), 250);
  }
  function typeQuery() {
    clearTimeout(timer);
    if (composing) return;
    if (query) {
      queueUpdate();
    } else {
      void update();
    }
  }
  function change(key: string, value: string) {
    values = { ...values, [key]: value };
    if (key === 'date') {
      values.from = '';
      values.to = '';
    }
    void update();
  }
  function clear(all = false) {
    values = Object.fromEntries(
      Object.entries(values).filter(([key]) => key === 'sort'),
    );
    if (all) {
      query = '';
      values = {};
    }
    void update();
  }
  function label(key: string) {
    if (key === 'date')
      return values.date === 'custom'
        ? `${values.from || 'Start date'} – ${values.to || values.from || 'End date'}`
        : dateOptions[values.date as keyof typeof dateOptions];
    return (
      filters.find((filter) => filter.key === key)?.options?.[values[key]] ??
      values[key]
    );
  }

  function keyboard(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      if (sortPanel.open) {
        sortPanel.open = false;
        sortPanel.querySelector('summary')?.focus();
      }
      if (filterPanel.open) {
        filterPanel.open = false;
        filterPanel.querySelector('summary')?.focus();
      }
    }
    if (
      event.key !== '/' ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.defaultPrevented ||
      (event.target instanceof Element &&
        event.target.closest(
          'input, textarea, select, [contenteditable], [role="textbox"], dialog, [role="dialog"]',
        ))
    )
      return;
    event.preventDefault();
    input.focus();
  }
  function fitPopovers() {
    for (const panel of [sortPanel, filterPanel]) {
      const popover = panel?.querySelector('.search-popover');
      if (panel?.open && popover instanceof HTMLElement) {
        popover.style.maxHeight = `${Math.max(0, Math.min(650, window.innerHeight - popover.getBoundingClientRect().top - 16))}px`;
      }
    }
  }
  function outside(event: PointerEvent) {
    if (!(event.target instanceof Node)) return;
    if (!sortPanel.contains(event.target)) sortPanel.open = false;
    if (!filterPanel.contains(event.target)) filterPanel.open = false;
  }
</script>

<svelte:window
  onkeydown={keyboard}
  onpointerdown={outside}
  onresize={fitPopovers}
  onscroll={fitPopovers}
/>
<div class="collection-search">
  <div class="search-controls">
    <div class="search-field">
      <Search size={18} aria-hidden="true" />
      <input
        bind:this={input}
        bind:value={query}
        oninput={typeQuery}
        oncompositionstart={() => {
          composing = true;
          clearTimeout(timer);
        }}
        oncompositionend={() => {
          composing = false;
          typeQuery();
        }}
        aria-label={`Search ${plural}`}
        aria-keyshortcuts="/"
        placeholder={`Search ${plural}…`}
        maxlength="240"
      />
      {#if query}<button
          class="search-clear"
          aria-label="Clear search"
          title="Clear search"
          onclick={() => {
            query = '';
            void update();
            input.focus();
          }}><X size={16} /></button
        >{/if}
    </div>
    <details
      bind:this={sortPanel}
      bind:open={sortOpen}
      class="search-menu"
      ontoggle={fitPopovers}
    >
      <summary
        class="search-trigger"
        class:active={sort !== 'newest'}
        aria-label={`Sort ${plural}: ${sortOptions[sort]}`}
        title={`Sort ${plural}`}><ArrowUpDown size={18} /></summary
      >
      <div
        class="search-popover sort-popover"
        inert={!sortOpen}
        aria-hidden={!sortOpen}
      >
        <strong>Sort {plural}</strong>
        {#each Object.entries(sortOptions).filter(([key]) => key !== 'best' || text) as [key, name] (key)}
          <label class="sort-choice"
            ><input
              type="radio"
              name={`${plural}-sort`}
              checked={sort === key}
              onchange={() => change('sort', key)}
            />{name}</label
          >
        {/each}
      </div>
    </details>
    <details
      bind:this={filterPanel}
      bind:open={filterOpen}
      class="search-menu"
      ontoggle={fitPopovers}
    >
      <summary
        class="search-trigger"
        class:active={active.length > 0}
        aria-label={`Filter ${plural}${active.length > 0 ? `: ${active.length} active` : ''}`}
        title={`Filter ${plural}`}
        ><ListFilter size={18} />{#if active.length}<span class="filter-count"
            >{active.length}</span
          >{/if}</summary
      >
      <div
        class="search-popover filter-popover"
        inert={!filterOpen}
        aria-hidden={!filterOpen}
      >
        <strong>Filter {plural}</strong>
        <label
          >{dateLabel} (local time)<select
            value={values.date || ''}
            onchange={(event) => change('date', event.currentTarget.value)}
            ><option value="">Any date</option
            >{#each Object.entries(dateOptions) as [key, name] (key)}<option
                value={key}>{name}</option
              >{/each}</select
          ></label
        >
        {#if values.date === 'custom'}
          <div class="date-range" in:fadeMotion={{ kind: 'content' }}>
            <label
              >From<input
                type="date"
                value={values.from || ''}
                max={values.to || undefined}
                onchange={(event) => change('from', event.currentTarget.value)}
              /></label
            >
            <label
              >Through<input
                type="date"
                value={values.to || ''}
                min={values.from || undefined}
                onchange={(event) => change('to', event.currentTarget.value)}
              /></label
            >
          </div>
          <small>Choose only a start date for a single day.</small>
          {#if !dateRange('custom', values.from, values.to)}<small
              transition:fadeMotion={{ kind: 'content' }}
              >Choose a valid start date and an end date on or after it.</small
            >{/if}
        {/if}
        {#each filters as filter (filter.key)}
          <label
            >{filter.label}
            {#if filter.options}
              <select
                value={values[filter.key] || ''}
                onchange={(event) =>
                  change(filter.key, event.currentTarget.value)}
              >
                <option value="">{filter.placeholder}</option>
                {#each Object.entries(filter.options) as [key, name] (key)}<option
                    value={key}>{name}</option
                  >{/each}
              </select>
            {:else}
              <input
                value={values[filter.key] || ''}
                placeholder={filter.placeholder}
                maxlength="240"
                oninput={(event) => {
                  values = {
                    ...values,
                    [filter.key]: event.currentTarget.value,
                  };
                  queueUpdate();
                }}
              />
            {/if}
          </label>
        {/each}
        <button disabled={active.length === 0} onclick={() => clear()}
          >Clear filters</button
        >
      </div>
    </details>
  </div>
  <div class="search-status">
    <small role="status" aria-live="polite"
      >{total === unfilteredTotal ? total : `${total} of ${unfilteredTotal}`}
      {total === 1 ? noun : plural}{navigating.to
        ? ' · Updating…'
        : ''}&nbsp;·&nbsp;{sortOptions[sort]}</small
    >
    {#if query || active.length}<button
        transition:fadeMotion={{ kind: 'content' }}
        class="text-control"
        onclick={() => clear(true)}>Clear all</button
      >{/if}
  </div>
  {#if active.length || dateRange(query.trim().toLowerCase())}<div
      class="filter-chips"
    >
      {#each active as key (key)}<button
          transition:fadeMotion={{ kind: 'content' }}
          onclick={() => change(key, '')}
          aria-label={`Remove ${key} filter: ${label(key)}`}
          >{label(key)}<X size={12} /></button
        >{/each}
      {#if dateRange(query.trim().toLowerCase())}<button
          transition:fadeMotion={{ kind: 'content' }}
          onclick={() => {
            query = '';
            void update();
          }}>{dateLabel}: {query} (local time)<X size={12} /></button
        >{/if}
    </div>{/if}
</div>
