<script lang="ts">
  import { indicatorMotion } from '$lib/motion';

  const [sendIndicator, receiveIndicator] = indicatorMotion();
  const { section }: { section: string } = $props();
  const adminTabs = [
    ['overview', 'Overview'],
    ['users', 'Users'],
    ['images', 'Images'],
    ['links', 'Links'],
    ['domains', 'Domains'],
    ['storage', 'Storage'],
    ['audit-log', 'Audit log'],
    ['settings', 'Settings'],
  ];
</script>

<nav class="admin-tabs" aria-label="Administration">
  {#each adminTabs as [key, label] (key)}<a
      class:active={section === key}
      href={key === 'overview' ? '/admin' : `/admin/${key}`}
    >
      {#if section === key}<span
          class="navigation-indicator"
          data-motion
          in:receiveIndicator={{ key: 'administration' }}
          out:sendIndicator={{ key: 'administration' }}
          aria-hidden="true"
        ></span>{/if}{label}</a
    >{/each}
</nav>
