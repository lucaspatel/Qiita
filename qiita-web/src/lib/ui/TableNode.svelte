<script lang="ts" module>
  import type { Column } from '$lib/preflight/db';
  export type TableNodeData = { name: string; columns: Column[]; fkCols: Set<string> };
</script>

<script lang="ts">
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  let { data }: NodeProps = $props();
  const d = $derived(data as TableNodeData);
</script>

<!-- One table in the ER diagram: a header plus its columns, with a target handle
     on the left and a source handle on the right for the FK edges. -->
<div class="w-56 overflow-hidden rounded-md border border-gray-300 bg-white shadow-sm">
  <Handle type="target" position={Position.Left} style="background:#14b8a6" />
  <Handle type="source" position={Position.Right} style="background:#14b8a6" />
  <div class="border-b border-gray-200 bg-gray-50 px-2 py-1 font-mono text-xs font-semibold text-gray-900">{d.name}</div>
  <ul class="divide-y divide-gray-100 text-[11px]">
    {#each d.columns as c (c.name)}
      <li class="flex items-center gap-1.5 px-2 py-0.5">
        <span class="font-mono text-gray-800">{c.name}</span>
        {#if c.pk}<span class="rounded bg-amber-100 px-1 text-[9px] font-medium text-amber-800">PK</span>{/if}
        {#if d.fkCols.has(c.name)}<span class="rounded bg-blue-100 px-1 text-[9px] font-medium text-blue-800">FK</span>{/if}
        <span class="ml-auto font-mono text-[10px] text-gray-400">{c.type}</span>
      </li>
    {/each}
  </ul>
</div>
