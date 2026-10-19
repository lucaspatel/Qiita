<script lang="ts">
  // App frame adapted from the Tailwind UI "brand sidebar" application shell
  // (recolored teal, desktop-first). Owns the auth control + the AuthRocket
  // loopback redemption, so routes only render page content.
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { auth } from '$lib/auth.svelte';
  import { api, cliExchange, type Whoami } from '$lib/api';
  import { cn } from '$lib/utils';
  import { isAdminRole, isSystemAdmin } from '$lib/roles';
  import EnvSwitcher from './EnvSwitcher.svelte';
  import LoginMenu from './LoginMenu.svelte';

  let { children } = $props();
  let exchanging = $state(false);
  let loginError = $state('');
  let me = $state<Whoami | null>(null);
  let menuOpen = $state(false);
  let drawerOpen = $state(false);
  const initials = $derived((me?.email ?? '?').slice(0, 1).toUpperCase());

  $effect(() => {
    if (auth.isSet) api.whoami().then((r) => (me = r.ok ? r.data : null));
    else me = null;
  });

  onMount(async () => {
    const url = new URL(location.href);
    const otCode = url.searchParams.get('ot_code');
    if (!otCode) return;
    exchanging = true;
    const r = await cliExchange(otCode);
    if (r.ok) auth.set(r.data.token);
    else loginError = `login failed: HTTP ${r.status} — ${r.detail}`;
    url.searchParams.delete('ot_code');
    history.replaceState({}, '', url.pathname + url.search);
    exchanging = false;
  });

  // The sidebar in sections: home, the study data, and the wet lab's tools. The shared
  // catalogs (references, prep protocols) are reached from Home and Workflows instead.
  // `staff` items show only to wet_lab_admin and above (the server gates their actions;
  // this only hides what a role can't use).
  type NavItem = { label: string; href: string; path: string; staff?: boolean; admin?: boolean };
  const sections: NavItem[][] = [
    [
      {
        label: 'Home',
        href: '/',
        path: 'm2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25'
      },
      {
        label: 'Papers',
        href: '/papers',
        path: 'M12 7.5h1.5m-1.5 3h1.5m-7.5 3h7.5m-7.5 3h7.5m3-9h3.375c.621 0 1.125.504 1.125 1.125V18a2.25 2.25 0 0 1-2.25 2.25M16.5 7.5V18a2.25 2.25 0 0 0 2.25 2.25M16.5 7.5V4.875c0-.621-.504-1.125-1.125-1.125H4.125C3.504 3.75 3 4.254 3 4.875V18a2.25 2.25 0 0 0 2.25 2.25h13.5M6 7.5h3v3H6v-3Z'
      }
    ],
    [
      {
        label: 'Studies',
        href: '/studies',
        path: 'M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z'
      },
      {
        label: 'Workflows',
        href: '/workflows',
        path: 'M14.25 6.087c0-.355.186-.676.401-.959.221-.29.349-.634.349-1.003 0-1.036-1.007-1.875-2.25-1.875s-2.25.84-2.25 1.875c0 .369.128.713.349 1.003.215.283.401.604.401.959v0a.64.64 0 0 1-.657.643 48.39 48.39 0 0 1-4.163-.3c.186 1.613.293 3.25.315 4.907a.656.656 0 0 1-.658.663v0c-.355 0-.676-.186-.959-.401a1.647 1.647 0 0 0-1.003-.349c-1.036 0-1.875 1.007-1.875 2.25s.84 2.25 1.875 2.25c.369 0 .713-.128 1.003-.349.283-.215.604-.401.959-.401v0c.31 0 .555.26.532.57a48.039 48.039 0 0 1-.642 5.056c1.518.19 3.058.309 4.616.354a.64.64 0 0 0 .667-.66v0c0-.355-.186-.676-.401-.959a1.647 1.647 0 0 1-.349-1.003c0-1.035 1.008-1.875 2.25-1.875 1.243 0 2.25.84 2.25 1.875 0 .37-.128.713-.349 1.003-.215.283-.401.604-.401.959v0c0 .369.3.668.668.65 1.56-.078 3.1-.243 4.615-.49a48.396 48.396 0 0 0 .635-4.773.656.656 0 0 0-.657-.714v0c-.355 0-.676.186-.959.401-.29.221-.634.349-1.003.349-1.035 0-1.875-1.007-1.875-2.25s.84-2.25 1.875-2.25c.37 0 .713.128 1.003.349.283.215.604.401.959.401v0a.656.656 0 0 0 .659-.663 47.703 47.703 0 0 0-.31-4.82c-1.517.19-3.058.309-4.616.355a.64.64 0 0 1-.667-.66v0Z'
      },
      {
        label: 'Jobs',
        href: '/tickets',
        path: 'M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Z'
      }
    ],
    [
      {
        label: 'Library prep',
        href: '/library-prep',
        staff: true,
        path: 'M9.75 3.104v5.714a2.25 2.25 0 0 1-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 0 1 4.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0 1 12 15a9.065 9.065 0 0 0-6.23-.693L5 14.5m14.8.8 1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0 1 12 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5'
      },
      {
        label: 'Preflight',
        href: '/preflight',
        staff: true,
        path: 'M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 0 1-1.125-1.125M3.375 19.5h7.5c.621 0 1.125-.504 1.125-1.125m-9.75 0V5.625m0 12.75v-1.5c0-.621.504-1.125 1.125-1.125m18.375 2.625V5.625m0 12.75c0 .621-.504 1.125-1.125 1.125m1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125m0 3.75h-7.5A1.125 1.125 0 0 1 12 18.375m9.75-12.75c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125m19.5 0v1.5c0 .621-.504 1.125-1.125 1.125M2.25 5.625v1.5c0 .621.504 1.125 1.125 1.125m0 0h17.25m-17.25 0h7.5c.621 0 1.125.504 1.125 1.125M3.375 8.25c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125m0 0h7.5M3.375 12c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125m0 0h7.5'
      },
      {
        label: 'Admin',
        href: '/admin',
        admin: true,
        path: 'M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.241.437-.613.43-.992a7.723 7.723 0 0 1 0-.255c.007-.378-.138-.75-.43-.991l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.281Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z'
      }
    ]
  ];
  const nav = $derived(
    sections
      .map((items) =>
        items.filter(
          (i) => (!i.staff || isAdminRole(me?.system_role)) && (!i.admin || isSystemAdmin(me?.system_role))
        )
      )
      .filter((items) => items.length)
  );

  function isActive(href: string): boolean {
    return href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(href);
  }
</script>

{#snippet brand(dark: boolean)}
  <span class="flex items-center gap-2.5">
    <span
      class="flex size-9 items-center justify-center rounded-lg shadow-sm {dark ? 'bg-white' : 'bg-teal-700'}"
    >
      <span class="font-serif text-2xl leading-none font-bold {dark ? 'text-teal-700' : 'text-white'}">Q</span>
    </span>
    <span class="text-lg font-semibold tracking-tight whitespace-nowrap {dark ? 'text-white' : 'text-teal-800'}"
      >Qiita <span class="text-xs font-normal {dark ? 'text-teal-300' : 'text-teal-600'}">miint</span></span
    >
  </span>
{/snippet}

{#snippet navList(onNavigate?: () => void)}
  {#each nav as items, i}
    {#if i}
      <div class="my-3 border-t border-teal-700" role="separator"></div>
    {/if}
    <ul class="-mx-2 space-y-1">
      {#each items as item}
        <li>
          <a
            href={item.href}
            onclick={onNavigate}
            class={cn(
              'group flex items-center gap-x-3 rounded-md p-2 text-sm font-semibold',
              isActive(item.href)
                ? 'bg-teal-900 text-white'
                : 'text-teal-100 hover:bg-teal-900 hover:text-white'
            )}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="size-5 shrink-0">
              <path d={item.path} stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            {item.label}
          </a>
        </li>
      {/each}
    </ul>
  {/each}
{/snippet}

<div class="min-h-screen bg-gray-50 text-gray-900">
  <!-- Desktop sidebar -->
  <div class="hidden lg:fixed lg:inset-y-0 lg:z-40 lg:flex lg:w-64 lg:flex-col">
    <div class="flex grow flex-col gap-y-6 overflow-y-auto bg-teal-800 px-6 pb-4">
      <div class="flex h-16 shrink-0 items-center">{@render brand(true)}</div>
      <nav class="flex flex-1 flex-col">{@render navList()}</nav>
    </div>
  </div>

  <!-- Mobile drawer: the same navigation, opened from the header's menu button. -->
  {#if drawerOpen}
    <div class="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
      <button
        type="button"
        class="absolute inset-0 bg-gray-900/60"
        aria-label="Close navigation"
        onclick={() => (drawerOpen = false)}
      ></button>
      <div class="relative flex h-full w-72 max-w-[80%] flex-col gap-y-6 overflow-y-auto bg-teal-800 px-6 pb-4">
        <div class="flex h-16 shrink-0 items-center justify-between">
          {@render brand(true)}
          <button
            type="button"
            class="-mr-2 rounded-md p-2 text-teal-100 hover:bg-teal-900 hover:text-white"
            aria-label="Close navigation"
            onclick={() => (drawerOpen = false)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="size-6">
              <path d="M6 18 18 6M6 6l12 12" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </div>
        <nav class="flex flex-1 flex-col">{@render navList(() => (drawerOpen = false))}</nav>
      </div>
    </div>
  {/if}

  <!-- Main column -->
  <div class="lg:pl-64">
    <header
      class="sticky top-0 z-30 flex h-16 items-center gap-x-4 border-b border-gray-200 bg-white px-4 shadow-sm sm:px-6 lg:px-8"
    >
      <button
        type="button"
        class="-ml-2 rounded-md p-2 text-gray-600 hover:bg-gray-100 lg:hidden"
        aria-label="Open navigation"
        onclick={() => (drawerOpen = true)}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="size-6">
          <path d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <a href="/" class="lg:hidden">{@render brand(false)}</a>
      <div class="flex flex-1 items-center justify-end gap-x-3 text-sm">
        <EnvSwitcher />
        <span class="h-6 w-px bg-gray-200" aria-hidden="true"></span>
        {#if exchanging}
          <span class="text-gray-500">signing in…</span>
        {:else if auth.isSet}
          <details bind:open={menuOpen} class="relative">
            <summary
              class="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1.5 hover:bg-gray-100"
            >
              <span
                class="flex size-7 items-center justify-center rounded-full bg-teal-600 text-xs font-semibold text-white"
                >{initials}</span
              >
              <span class="hidden text-gray-700 sm:inline">{me?.email ?? '…'}</span>
              <svg viewBox="0 0 20 20" fill="currentColor" class="size-4 text-gray-400">
                <path
                  fill-rule="evenodd"
                  d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.168l3.71-3.938a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z"
                  clip-rule="evenodd"
                />
              </svg>
            </summary>
            <div
              class="absolute right-0 z-20 mt-2 w-56 rounded-md border border-gray-200 bg-white py-1 shadow-lg"
            >
              {#if me}
                <div class="border-b border-gray-100 px-3 py-2">
                  <p class="truncate text-sm font-medium text-gray-900">{me.email}</p>
                  <p class="text-xs text-gray-500">role: {me.system_role}</p>
                </div>
              {/if}
              <a
                href="/profile"
                class="block px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                onclick={() => (menuOpen = false)}>Profile</a
              >
              <a
                href="/settings"
                class="block px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                onclick={() => (menuOpen = false)}>Settings</a
              >
              <div class="my-1 border-t border-gray-100"></div>
              <button
                class="block w-full px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
                onclick={() => {
                  menuOpen = false;
                  auth.clear();
                }}>Sign out</button
              >
            </div>
          </details>
        {:else}
          <LoginMenu />
        {/if}
      </div>
    </header>

    {#if loginError}
      <p class="bg-red-50 px-4 py-2 text-center text-sm text-red-700">{loginError}</p>
    {/if}

    <main class="py-8">
      <div class="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        {@render children()}
      </div>
    </main>
  </div>
</div>
