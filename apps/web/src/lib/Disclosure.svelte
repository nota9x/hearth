<script lang="ts">
  import type { LucideIcon } from '@lucide/svelte';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import type { Snippet } from 'svelte';

  import { revealMotion } from '#lib/reveal.svelte.ts';

  const {
    title,
    description,
    icon: SectionIcon,
    header,
    class: className = '',
    children,
  }: {
    title: string;
    description?: string;
    icon?: LucideIcon;
    header?: Snippet;
    class?: string;
    children: Snippet;
  } = $props();
  let open = $state(false);
</script>

<details class={`disclosure ${className}`} bind:open>
  <!-- svelte-ignore a11y_no_redundant_roles (Explicit role keeps nested summary content exposed as a button in Chromium.) -->
  <summary role="button" aria-label={title} aria-expanded={open}>
    {#if SectionIcon}<span class="section-icon"
        ><SectionIcon size={19} aria-hidden="true" /></span
      >{/if}
    {#if header}{@render header()}{:else}<span class="heading"
        ><strong>{title}</strong>{#if description}<small>{description}</small
          >{/if}</span
      >{/if}
    <ChevronDown class="chevron" size={18} aria-hidden="true" />
  </summary>
  <div
    class="disclosure-reveal"
    {@attach revealMotion(() => open)}
    inert={!open}
    aria-hidden={!open}
  >
    <div class="content">{@render children()}</div>
  </div>
</details>

<style>
  .disclosure {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    margin-bottom: 1rem;
    overflow: hidden;
  }
  summary {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 20px 24px;
    border-radius: calc(var(--radius) - 1px);
    list-style: none;
    cursor: pointer;
    transition: background-color var(--motion-state) var(--motion-enter);
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary:hover {
    background: #312820;
  }
  summary:focus-visible {
    outline: 2px solid #e6a479;
    outline-offset: -2px;
  }
  .section-icon {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    color: var(--accent);
  }
  .heading {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  strong {
    font-size: 1rem;
    font-weight: 600;
  }
  small {
    display: block;
    font-size: 0.8rem;
    color: var(--muted);
    margin-top: 3px;
  }
  summary :global(.chevron) {
    flex-shrink: 0;
    color: var(--muted);
    transition:
      transform var(--motion-state) var(--motion-enter),
      color var(--motion-state) var(--motion-enter);
  }
  details[open] summary,
  :global(details[data-collapsing]) summary {
    border-radius: calc(var(--radius) - 1px) calc(var(--radius) - 1px) 0 0;
    background: #252019;
  }
  details[open] summary:hover,
  :global(details[data-collapsing]) summary:hover {
    background: #312820;
  }
  details summary:active {
    background: color-mix(in srgb, #312820 92%, white);
    transition-duration: var(--motion-press);
  }
  details[open] summary :global(.chevron) {
    transform: rotate(180deg);
    color: var(--accent);
  }
  .content {
    border-top: 1px solid var(--border);
    padding: 24px;
  }
  details::details-content {
    content-visibility: visible;
  }
  .disclosure-reveal {
    height: 0;
    opacity: 0;
    overflow: hidden;
  }
  details[open] .disclosure-reveal {
    height: auto;
    opacity: 1;
  }
  @media (max-width: 600px) {
    summary {
      padding: 18px;
      gap: 10px;
    }
    .content {
      padding: 20px 18px;
    }
  }
</style>
