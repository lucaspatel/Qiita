<script lang="ts">
  // Signed-out control: AuthRocket as the primary action, with a dropdown to
  // log in with a PAT — pasted, or (dev builds) loaded from the qiita CLI's
  // token file for this environment.
  import { auth } from '$lib/auth.svelte';
  import { beginLogin, loginIsSeamless } from '$lib/api';
  import { cliTokenExists, current, fetchCliToken } from '$lib/environment';

  let open = $state(false);
  let draft = $state('');
  let cliError = $state('');
  // Whether the CLI has a token file for this environment; the Load button
  // shows only when it does. Re-checked on each open, so a `qiita login` in
  // another terminal shows up without a reload.
  let onDisk = $state(false);

  $effect(() => {
    if (open && current) cliTokenExists(current.name).then((v) => (onDisk = v));
  });

  async function loadFromDisk() {
    if (!current) return;
    cliError = '';
    const r = await fetchCliToken(current.name);
    if (r.ok) draft = r.token;
    else cliError = r.detail;
  }
</script>

<div class="relative inline-flex rounded-md shadow-sm">
  <button
    class="rounded-l-md bg-teal-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-teal-600"
    onclick={() => {
      beginLogin();
      // A non-loopback origin can't receive the login back; offer the PAT box.
      if (!loginIsSeamless()) open = true;
    }}>Log in with AuthRocket</button
  >
  <details bind:open>
    <summary
      class="flex h-full cursor-pointer list-none items-center rounded-r-md border-l border-teal-600 bg-teal-700 px-2 text-white hover:bg-teal-600"
      aria-label="Other ways to sign in"
    >
      <svg viewBox="0 0 20 20" fill="currentColor" class="size-4">
        <path
          fill-rule="evenodd"
          d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.168l3.71-3.938a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z"
          clip-rule="evenodd"
        />
      </svg>
    </summary>
    <div
      class="absolute right-0 z-20 mt-2 w-96 rounded-md border border-gray-200 bg-white shadow-lg"
    >
      <div class="px-3 py-2">
        <label for="pat" class="mb-1 block text-xs font-medium text-gray-500"
          >Log in with a personal access token</label
        >
        <div class="flex gap-2">
          {#if current && onDisk}
            <button
              class="shrink-0 rounded-md bg-white px-2.5 py-1 text-sm font-medium text-gray-700 ring-1 ring-gray-300 ring-inset hover:bg-gray-50"
              title="~/.qiita/tokens/{current.name}"
              onclick={loadFromDisk}>Load from disk</button
            >
            <span class="self-center text-xs text-gray-400">or</span>
          {/if}
          <input
            id="pat"
            type="password"
            placeholder="qk_…"
            class="min-w-0 flex-1 rounded-md border border-gray-300 px-2 py-1 text-sm"
            bind:value={draft}
            onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && draft && auth.set(draft)}
          />
          <button
            class="shrink-0 rounded-md bg-teal-700 px-2.5 py-1 text-sm font-semibold text-white hover:bg-teal-600 disabled:opacity-50"
            disabled={!draft}
            onclick={() => auth.set(draft)}>Log in</button
          >
        </div>
        {#if cliError}<p class="mt-1.5 text-xs text-red-700">{cliError}</p>{/if}
      </div>
    </div>
  </details>
</div>
