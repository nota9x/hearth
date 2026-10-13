<script lang="ts">
  import type { Snippet } from 'svelte';

  import SettingsInfo from './SettingsInfo.svelte';

  const {
    id,
    label,
    description,
    info,
    toggle = false,
    children,
    detail,
  }: {
    id?: string;
    label: string;
    description?: string;
    info?: string;
    toggle?: boolean;
    children: Snippet;
    detail?: Snippet;
  } = $props();
</script>

<div class="settings-row" class:settings-switch-row={toggle}>
  <div class="settings-label">
    <div class="settings-label-line">
      {#if id}<label for={id}>{label}</label>{:else}<strong>{label}</strong
        >{/if}
      {#if info}<SettingsInfo {label} text={info} />{/if}
    </div>
    {#if description}<p>{description}</p>{/if}
    {#if detail}<div class="settings-detail">{@render detail()}</div>{/if}
  </div>
  <div class="settings-control">{@render children()}</div>
</div>
