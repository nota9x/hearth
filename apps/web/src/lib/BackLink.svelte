<script lang="ts">
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';

  const { href, label }: { href: string; label: string } = $props();
</script>

<a {href}><ArrowLeft size={16} aria-hidden="true" />{label}</a>

<style>
  a {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    padding: 8px 10px;
    margin-left: -10px;
    border-radius: 9px;
    color: #dda07a;
    font-size: 0.85rem;
    transition:
      background-color var(--motion-state) var(--motion-enter),
      color var(--motion-state) var(--motion-enter);
  }
  a :global(svg) {
    flex-shrink: 0;
  }
  a:hover {
    background: #312820;
    color: #e6b495;
  }
  a:active {
    background: color-mix(in srgb, #312820 92%, white);
    transition-duration: var(--motion-press);
  }
</style>
