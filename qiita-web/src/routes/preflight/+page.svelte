<script lang="ts">
  // Preflight tool — open a run-preflight .db in the browser, query it, edit it,
  // and export the result. Mirrors the CLI's local-file model (open a preflight,
  // read its rows, edit, then submit); nothing is fetched from or sent to the
  // server, so the service-account-only preflight GET is never involved.
  import {
    allRelations,
    changes,
    columns,
    exportBytes,
    foreignKeys,
    objectSql,
    openPreflight,
    run,
    schemaVersion,
    tables,
    viewNames,
    type QueryResult,
    type TableInfo
  } from '$lib/preflight/db';
  import { api, type Whoami } from '$lib/api';
  import { auth } from '$lib/auth.svelte';
  import { isAdminRole } from '$lib/roles';
  import type { Database } from 'sql.js';
  import { SvelteFlow, Background, Controls, MiniMap, type Node, type Edge } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';
  import TableNode, { type TableNodeData } from '$lib/ui/TableNode.svelte';

  const nodeTypes = { table: TableNode };
  let flowNodes = $state.raw<Node[]>([]);
  let flowEdges = $state.raw<Edge[]>([]);

  // Lay the tables out left-to-right by FK depth (reference tables on the left,
  // the deep per-sample tables on the right); each node is draggable from there.
  function buildDiagram(d: Database) {
    const names = tables(d).map((t) => t.name);
    const refs = new Map(names.map((n) => [n, foreignKeys(d, n)]));
    const rank = new Map<string, number>();
    const stack = new Set<string>();
    const rankOf = (t: string): number => {
      if (rank.has(t)) return rank.get(t)!;
      if (stack.has(t)) return 0; // cycle guard (schema is a DAG, but be safe)
      stack.add(t);
      const parents = (refs.get(t) ?? []).map((f) => f.table).filter((p) => p !== t);
      const r = parents.length ? 1 + Math.max(...parents.map(rankOf)) : 0;
      stack.delete(t);
      rank.set(t, r);
      return r;
    };
    const yByRank = new Map<number, number>();
    flowNodes = names.map((name) => {
      const cols = columns(d, name);
      const fkCols = new Set((refs.get(name) ?? []).map((f) => f.from));
      const r = rankOf(name);
      const y = yByRank.get(r) ?? 0;
      yByRank.set(r, y + 24 + cols.length * 17 + 36); // stack by estimated height
      return {
        id: name,
        type: 'table',
        position: { x: r * 300, y },
        data: { name, columns: cols, fkCols } satisfies TableNodeData
      };
    });
    flowEdges = allRelations(d).map((e, i) => ({
      id: `e${i}`,
      source: e.from,
      target: e.to,
      label: e.fromCol,
      style: 'stroke:#94a3b8',
      labelStyle: 'font-size:10px;fill:#64748b'
    }));
  }

  // Gate to wet_lab_admin or higher — the same roles the server lets edit a
  // preflight (lane update) and submit a pool. This only hides the UI; the server
  // enforces on any action that reaches it.
  let me = $state<Whoami | null>(null);
  let meLoaded = $state(false);
  $effect(() => {
    if (auth.isSet) api.whoami().then((r) => ((me = r.ok ? r.data : null), (meLoaded = true)));
    else meLoaded = true;
  });
  const allowed = $derived(isAdminRole(me?.system_role));

  let db = $state<Database | null>(null);
  let fileName = $state('');
  let version = $state(0);
  let tableList = $state<TableInfo[]>([]);
  let edited = $state(false);
  let dragging = $state(false);
  let error = $state('');

  let sql = $state('');
  let result = $state<QueryResult | null>(null);
  let note = $state('');

  // Data mode runs SQL; Schema mode shows a table/view's columns and relations.
  let mode = $state<'data' | 'schema'>('data');
  let selected = $state<string | null>(null);
  let views = $state<string[]>([]);

  const refresh = () => {
    if (!db) return;
    version = schemaVersion(db);
    tableList = tables(db);
    views = viewNames(db);
  };

  const pick = (name: string) => {
    if (mode === 'schema') selected = name;
    else browse(name);
  };

  async function openFile(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    error = '';
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      db = await openPreflight(bytes);
      fileName = f.name;
      edited = false;
      result = null;
      note = '';
      sql = 'SELECT * FROM processing_run;';
      refresh();
      buildDiagram(db);
    } catch (e) {
      error = `Could not open ${f.name}: ${e instanceof Error ? e.message : String(e)}`;
      db = null;
    }
  }

  const isWrite = (text: string) => /^\s*(update|insert|delete|replace|alter|drop|create)\b/i.test(text);

  function execute() {
    if (!db) return;
    error = '';
    note = '';
    try {
      result = run(db, sql);
      if (isWrite(sql)) {
        edited = true;
        note = `${changes(db)} row(s) changed`;
        refresh();
      } else {
        note = `${result.rows.length} row(s)`;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      result = null;
    }
  }

  const browse = (t: string) => {
    sql = `SELECT * FROM "${t}" LIMIT 200;`;
    execute();
  };

  function exportDb() {
    if (!db) return;
    const bytes = exportBytes(db);
    const a = document.createElement('a');
    const base = fileName.replace(/\.db$/i, '') || 'preflight';
    // Copy into a plain ArrayBuffer so the Blob part type is unambiguous.
    const buf = bytes.slice().buffer as ArrayBuffer;
    a.href = URL.createObjectURL(new Blob([buf], { type: 'application/x-sqlite3' }));
    a.download = edited ? `${base}.edited.db` : `${base}.db`;
    a.click();
  }

  const field =
    'block w-full rounded-md bg-white px-3 py-1.5 font-mono text-xs text-gray-900 outline-1 -outline-offset-1 outline-gray-300 focus:outline-2 focus:-outline-offset-2 focus:outline-teal-600';
</script>

<div class="mb-6">
  <div class="flex items-center justify-between gap-3">
    <h1 class="text-2xl/7 font-bold text-gray-900">Preflight tool</h1>
    <span class="inline-flex rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 ring-1 ring-amber-600/20 ring-inset">Local</span>
  </div>
  <p class="mt-1 text-sm text-gray-500">Open a run-preflight <span class="font-mono text-xs">.db</span>, query and edit it in the browser, and export the result — the CLI's local-file model.</p>
</div>

{#if !meLoaded}
  <p class="text-sm text-gray-500">Checking access…</p>
{:else if !allowed}
  <div class="rounded-md bg-amber-50 p-4 text-sm text-amber-800 ring-1 ring-amber-600/20 ring-inset">
    The preflight tool requires the <span class="font-medium">wet_lab_admin</span> role or higher.
  </div>
{:else if !db}
  <div
    role="region"
    aria-label="Drop a preflight database"
    class="rounded-lg border-2 border-dashed p-10 text-center transition {dragging ? 'border-teal-500 bg-teal-50' : 'border-gray-300'}"
    ondragover={(e) => (e.preventDefault(), (dragging = true))}
    ondragleave={() => (dragging = false)}
    ondrop={(e) => (e.preventDefault(), (dragging = false), openFile(e.dataTransfer?.files ?? null))}
  >
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true" class="mx-auto size-10 text-gray-400"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" /></svg>
    <p class="mt-2 text-sm font-semibold text-gray-900">Drop a preflight <span class="font-mono text-xs">.db</span>, or
      <label class="cursor-pointer text-teal-700 hover:text-teal-600">choose a file<input type="file" accept=".db,.sqlite,.sqlite3" class="hidden" onchange={(e) => openFile(e.currentTarget.files)} /></label>
    </p>
    <p class="mt-1 text-xs text-gray-500">The file from <span class="font-mono">kl-run-preflight</span> or a <span class="font-mono">submit-*</span> blob.</p>
  </div>
{:else}
  <div class="grid grid-cols-1 gap-6 lg:grid-cols-[16rem_1fr]">
    <!-- left: file + tables -->
    <aside class="space-y-4">
      <div class="rounded-md border border-gray-200 p-3 text-sm">
        <div class="flex items-center gap-2">
          <span class="truncate font-mono text-xs text-gray-900">{fileName}</span>
          {#if edited}<span class="rounded bg-amber-100 px-1.5 text-xs text-amber-800">edited</span>{/if}
        </div>
        <p class="mt-1 text-xs text-gray-500">schema v{version} · {tableList.length} tables · {views.length} views</p>
        <div class="mt-2 flex gap-2">
          <button type="button" class="rounded-md bg-teal-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-teal-500" onclick={exportDb}>Export .db</button>
          <button type="button" class="rounded-md bg-white px-2.5 py-1 text-xs font-semibold text-gray-900 ring-1 ring-gray-300 ring-inset hover:bg-gray-50" onclick={() => (db = null)}>Close</button>
        </div>
      </div>

      <!-- Data runs SQL against a table; Schema shows its columns and relations. -->
      <div class="inline-flex rounded-md ring-1 ring-gray-300 ring-inset">
        {#each ['data', 'schema'] as m}
          <button type="button" class="px-3 py-1 text-xs font-medium capitalize first:rounded-l-md last:rounded-r-md {mode === m ? 'bg-teal-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}" onclick={() => (mode = m as 'data' | 'schema')}>{m}</button>
        {/each}
      </div>

      <ul role="list" class="divide-y divide-gray-100 rounded-md border border-gray-200 text-sm">
        {#each tableList as t (t.name)}
          <li>
            <button type="button" class="flex w-full items-center gap-2 px-3 py-1.5 text-left {mode === 'schema' && selected === t.name ? 'bg-teal-50' : 'hover:bg-gray-50'}" onclick={() => pick(t.name)}>
              <span class="truncate font-mono text-xs text-gray-900">{t.name}</span>
              <span class="ml-auto text-xs text-gray-400">{t.rows}</span>
            </button>
          </li>
        {/each}
      </ul>
      {#if views.length}
        <details class="rounded-md border border-gray-200 text-sm">
          <summary class="cursor-pointer px-3 py-1.5 text-xs font-medium text-gray-600">{views.length} views</summary>
          <ul role="list" class="divide-y divide-gray-100 border-t border-gray-100">
            {#each views as v (v)}
              <li>
                <button type="button" class="flex w-full items-center px-3 py-1.5 text-left {mode === 'schema' && selected === v ? 'bg-teal-50' : 'hover:bg-gray-50'}" onclick={() => pick(v)}>
                  <span class="truncate font-mono text-xs text-gray-600">{v}</span>
                </button>
              </li>
            {/each}
          </ul>
        </details>
      {/if}
    </aside>

    <!-- right: query + results (Data) or columns + relations (Schema) -->
    <section class="min-w-0 space-y-3">
      {#if mode === 'data'}
      <div>
        <textarea class="{field} min-h-20" bind:value={sql} spellcheck="false" onkeydown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && execute()}></textarea>
        <div class="mt-2 flex items-center gap-3">
          <button type="button" class="rounded-md bg-teal-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-teal-500" onclick={execute}>Run <span class="text-teal-200">⌘⏎</span></button>
          {#if isWrite(sql)}<span class="text-xs text-amber-700">write — edits the in-browser copy; export to keep it</span>{/if}
          {#if note}<span class="ml-auto text-xs text-gray-500">{note}</span>{/if}
        </div>
      </div>

      {#if error}
        <div class="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
      {:else if result}
        {#if result.columns.length}
          <div class="max-h-[70vh] max-w-full overflow-auto rounded-md border border-gray-200">
            <table class="min-w-full text-left text-xs">
              <thead class="sticky top-0 bg-gray-50 text-gray-600 shadow-sm">
                <tr>{#each result.columns as c}<th class="whitespace-nowrap px-3 py-2 font-medium">{c}</th>{/each}</tr>
              </thead>
              <tbody class="divide-y divide-gray-100">
                {#each result.rows as row}
                  <tr class="hover:bg-gray-50">{#each row as cell}<td class="max-w-xs truncate px-3 py-1.5 font-mono text-gray-800" title={String(cell ?? '')}>{cell === null ? 'NULL' : String(cell)}</td>{/each}</tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <p class="text-sm text-gray-500">No rows.</p>
        {/if}
      {/if}
      {:else}
        <!-- Interactive ER diagram: drag tables to rearrange, FK edges connect
             them (labelled with the referencing column), pan and zoom. -->
        <p class="text-xs text-gray-500">Drag tables to rearrange · scroll to zoom · edges are foreign keys (labelled with the referencing column).</p>
        <div class="h-[75vh] w-full overflow-hidden rounded-md border border-gray-200">
          <SvelteFlow bind:nodes={flowNodes} bind:edges={flowEdges} {nodeTypes} fitView>
            <Background />
            <Controls />
            <MiniMap pannable zoomable />
          </SvelteFlow>
        </div>
      {/if}
    </section>
  </div>
{/if}
