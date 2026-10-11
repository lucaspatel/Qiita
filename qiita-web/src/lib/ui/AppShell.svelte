<script lang="ts">
  // App frame adapted from the Tailwind UI "brand sidebar" application shell
  // (recolored teal, desktop-first). Owns the auth control + the AuthRocket
  // loopback redemption, so routes only render page content.
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { auth } from '$lib/auth.svelte';
  import { api, cliExchange, type Whoami } from '$lib/api';
  import { cn } from '$lib/utils';
  import EnvSwitcher from './EnvSwitcher.svelte';
  import LoginMenu from './LoginMenu.svelte';

  let { children } = $props();
  let exchanging = $state(false);
  let loginError = $state('');
  let me = $state<Whoami | null>(null);
  let menuOpen = $state(false);
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

  const nav = [
    {
      label: 'Studies',
      href: '/studies',
      path: 'M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z'
    },
    {
      label: 'Jobs',
      href: '/tickets',
      path: 'M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Z'
    },
    {
      label: 'Workflows',
      href: '/workflows',
      path: 'M14.25 6.087c0-.355.186-.676.401-.959.221-.29.349-.634.349-1.003 0-1.036-1.007-1.875-2.25-1.875s-2.25.84-2.25 1.875c0 .369.128.713.349 1.003.215.283.401.604.401.959v0a.64.64 0 0 1-.657.643 48.39 48.39 0 0 1-4.163-.3c.186 1.613.293 3.25.315 4.907a.656.656 0 0 1-.658.663v0c-.355 0-.676-.186-.959-.401a1.647 1.647 0 0 0-1.003-.349c-1.036 0-1.875 1.007-1.875 2.25s.84 2.25 1.875 2.25c.369 0 .713-.128 1.003-.349.283-.215.604-.401.959-.401v0c.31 0 .555.26.532.57a48.039 48.039 0 0 1-.642 5.056c1.518.19 3.058.309 4.616.354a.64.64 0 0 0 .667-.66v0c0-.355-.186-.676-.401-.959a1.647 1.647 0 0 1-.349-1.003c0-1.035 1.008-1.875 2.25-1.875 1.243 0 2.25.84 2.25 1.875 0 .37-.128.713-.349 1.003-.215.283-.401.604-.401.959v0c0 .369.3.668.668.65 1.56-.078 3.1-.243 4.615-.49a48.396 48.396 0 0 0 .635-4.773.656.656 0 0 0-.657-.714v0c-.355 0-.676.186-.959.401-.29.221-.634.349-1.003.349-1.035 0-1.875-1.007-1.875-2.25s.84-2.25 1.875-2.25c.37 0 .713.128 1.003.349.283.215.604.401.959.401v0a.656.656 0 0 0 .659-.663 47.703 47.703 0 0 0-.31-4.82c-1.517.19-3.058.309-4.616.355a.64.64 0 0 1-.667-.66v0Z'
    },
    {
      label: 'References',
      href: '/',
      path: 'M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125'
    },
    {
      label: 'Prep protocols',
      href: '/prep-protocols',
      path: 'M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25Z'
    }
  ];

  function isActive(href: string): boolean {
    return href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(href);
  }
</script>

<div class="min-h-screen bg-gray-50 text-gray-900">
  <!-- Desktop sidebar -->
  <div class="hidden lg:fixed lg:inset-y-0 lg:z-40 lg:flex lg:w-64 lg:flex-col">
    <div class="flex grow flex-col gap-y-6 overflow-y-auto bg-teal-800 px-6 pb-4">
      <div class="flex h-16 shrink-0 items-center gap-2.5">
        <span class="flex size-9 items-center justify-center rounded-lg bg-white shadow-sm">
          <span class="font-serif text-2xl leading-none font-bold text-teal-700">Q</span>
        </span>
        <span class="text-lg font-semibold tracking-tight text-white"
          >Qiita <span class="text-xs font-normal text-teal-300">miint</span></span
        >
      </div>
      <nav class="flex flex-1 flex-col">
        <ul class="-mx-2 space-y-1">
          {#each nav as item}
            <li>
              <a
                href={item.href}
                class={cn(
                  'group flex items-center gap-x-3 rounded-md p-2 text-sm font-semibold',
                  isActive(item.href)
                    ? 'bg-teal-900 text-white'
                    : 'text-teal-100 hover:bg-teal-900 hover:text-white'
                )}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  class="size-5 shrink-0"
                >
                  <path d={item.path} stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                {item.label}
              </a>
            </li>
          {/each}
        </ul>
      </nav>
    </div>
  </div>

  <!-- Main column -->
  <div class="lg:pl-64">
    <header
      class="sticky top-0 z-30 flex h-16 items-center gap-x-4 border-b border-gray-200 bg-white px-4 shadow-sm sm:px-6 lg:px-8"
    >
      <span class="text-lg font-semibold text-teal-800 lg:hidden">Qiita</span>
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
