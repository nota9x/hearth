<script lang="ts">
  import '@fontsource-variable/bitter';
  import '../app.css';

  import { brandStyles } from '@hearth/core/branding-view';
  import { motionStyles } from '@hearth/core/motion';
  import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
  import Globe from '@lucide/svelte/icons/globe';
  import House from '@lucide/svelte/icons/house';
  import Images from '@lucide/svelte/icons/images';
  import Link from '@lucide/svelte/icons/link';
  import LogOut from '@lucide/svelte/icons/log-out';
  import Menu from '@lucide/svelte/icons/menu';
  import Settings from '@lucide/svelte/icons/settings';
  import Shield from '@lucide/svelte/icons/shield';
  import X from '@lucide/svelte/icons/x';
  import { onMount } from 'svelte';
  import { prefersReducedMotion } from 'svelte/motion';
  import { MediaQuery } from 'svelte/reactivity';

  import Brand from '#lib/Brand.svelte';
  import { action } from '#lib/client.ts';
  import { dashboardSnapshot } from '#lib/dashboard.ts';
  import { linkDeletion, setDeletionOwner } from '#lib/deletion.ts';
  import { downloads, setDownloadOwner } from '#lib/downloads.ts';
  import GlobalUpload from '#lib/GlobalUpload.svelte';
  import { indicatorMotion } from '#lib/motion.ts';
  import NotificationDeck from '#lib/NotificationDeck.svelte';
  import { notify } from '#lib/notifications.ts';
  import { uploads } from '#lib/uploads.ts';
  import { beforeNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';

  import type { LayoutProps as LayoutProperties } from './$types';

  const { data: loadedData, children }: LayoutProperties = $props();
  const data = $derived($dashboardSnapshot ?? loadedData);
  const hasUnseenImages = $derived(
    $dashboardSnapshot
      ? $dashboardSnapshot.hasUnseenImages
      : Boolean(page.data.hasUnseenImages),
  );
  const [sendIndicator, receiveIndicator] = indicatorMotion();
  let menu = $state(false);
  let menuButton = $state<HTMLButtonElement>();
  const mobile = new MediaQuery('(max-width: 767px)');
  $effect(() => {
    if (!mobile.current) menu = false;
  });
  $effect(() => {
    if (prefersReducedMotion.current) {
      for (const animation of document.getAnimations()) {
        const effect = animation.effect;
        if (
          effect instanceof KeyframeEffect &&
          effect.target instanceof HTMLElement &&
          Object.hasOwn(effect.target.dataset, 'motion') &&
          Number.isFinite(effect.getComputedTiming().endTime)
        )
          animation.finish();
      }
    }
  });
  beforeNavigate(() => (menu = false));
  function escapeNavigation(event: KeyboardEvent) {
    if (!(event.key === 'Escape' && menu)) {
      return;
    }

    menu = false;
    menuButton?.focus();
  }
  $effect(() => uploads.setOwner(data.user?.id));
  $effect(() => {
    setDownloadOwner(data.user?.id ?? null);
    setDeletionOwner(data.user?.id ?? null);
    linkDeletion.setOwner(data.user?.id ?? null);
  });
  function beforeUnload(event: BeforeUnloadEvent) {
    if ($uploads || $downloads.active) event.preventDefault();
  }
  onMount(() => {
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  });
  const navigation = [
    { href: '/', label: 'Overview', icon: House },
    { href: '/images', label: 'Images', icon: Images },
    { href: '/links', label: 'Links', icon: Link },
    { href: '/domains', label: 'Domains', icon: Globe },
    { href: '/settings', label: 'Settings', icon: Settings },
  ];
  const activeNavigation = $derived(
    page.url.pathname.startsWith('/admin')
      ? '/admin'
      : navigation.find((item) =>
          item.href === '/'
            ? page.url.pathname === '/'
            : page.url.pathname.startsWith(item.href),
        )?.href,
  );
  async function logout() {
    try {
      await action('logout');
      await goto('/login', { refreshAll: true });
    } catch (error_) {
      notify.error(
        error_ instanceof Error ? error_.message : 'Could not sign out.',
      );
    }
  }
</script>

<svelte:head>
  <title>{data.siteName} · private image hosting</title>
  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
  {@html `<style>${brandStyles}${motionStyles}</style>`}
</svelte:head>
<svelte:window onkeydown={escapeNavigation} />
<a href="#main" class="skip-link">Skip to content</a>
{#if page.status >= 400}
  <main id="main">{@render children()}</main>
{:else if data.user && page.url.pathname !== '/onboarding' && !page.url.pathname.startsWith('/delete/')}
  <GlobalUpload
    defaultExpiry={data.user.defaultExpiry}
    policy={data.expiryPolicy!}
  />
  <div class="mobile-bar">
    <Brand name={data.siteName} href="/" /><button
      class="icon-button"
      bind:this={menuButton}
      aria-expanded={menu}
      aria-controls="main-navigation"
      aria-label={menu ? 'Close navigation' : 'Open navigation'}
      onclick={() => (menu = !menu)}
      >{#if menu}<X />{:else}<Menu />{/if}</button
    >
  </div>
  <aside id="main-navigation" class:open={menu} inert={mobile.current && !menu}>
    <Brand name={data.siteName} href="/" />
    <nav aria-label="Main navigation">
      {#each navigation as item (item.href)}<a
          href={item.href}
          onclick={() => (menu = false)}
          class:active={activeNavigation === item.href}
          >{#if activeNavigation === item.href}<span
              class="navigation-indicator"
              data-motion
              in:receiveIndicator={{ key: 'main' }}
              out:sendIndicator={{ key: 'main' }}
              aria-hidden="true"
            ></span>{/if}<item.icon
            size={19}
          />{item.label}{#if item.href === '/images' && hasUnseenImages}<span
              class="nav-dot"
            ></span>{/if}</a
        >{/each}
      {#if data.user.role === 'admin'}<a
          href="/admin"
          onclick={() => (menu = false)}
          class:active={activeNavigation === '/admin'}
          >{#if activeNavigation === '/admin'}<span
              class="navigation-indicator"
              data-motion
              in:receiveIndicator={{ key: 'main' }}
              out:sendIndicator={{ key: 'main' }}
              aria-hidden="true"
            ></span>{/if}<Shield size={19} />Administration<ArrowUpRight
            size={15}
          /></a
        >{/if}
    </nav>
    <div class="sidebar-bottom">
      <div class="account">
        <span class="avatar"
          >{data.user.displayName.slice(0, 1).toUpperCase()}</span
        >
        <div>
          <strong>{data.user.displayName}</strong><small
            >{data.user.role === 'admin' ? 'Administrator' : 'Member'}</small
          >
        </div>
        <button
          class="icon-button"
          aria-label="Sign out"
          title="Sign out"
          onclick={logout}><LogOut size={17} /></button
        >
      </div>
    </div>
  </aside>
  <main id="main" class="workspace">
    {@render children()}
  </main>
{:else}<main
    id="main"
    class={page.url.pathname === '/onboarding' ? undefined : 'standalone'}
  >
    {@render children()}
  </main>{/if}

<NotificationDeck />
