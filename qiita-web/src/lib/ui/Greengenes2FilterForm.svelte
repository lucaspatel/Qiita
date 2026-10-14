<script lang="ts">
  // Filter a rapid-16S feature table to the ASVs Greengenes2 places, ranked by its
  // taxonomy. Nothing is submitted or stored: it adds a dashed view node the server
  // computes on each read (`feature_filter: greengenes2`).
  import type { WorkflowFormProps } from '$lib/nodeWorkflows';

  let { onView }: WorkflowFormProps = $props();
</script>

<button
  type="button"
  class="rounded-md bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-500"
  onclick={() => onView({ filter: 'greengenes2', label: 'Greengenes2' })}
>
  Add filtered table
</button>
<p class="w-full text-xs text-gray-500">
  Keeps the V4 ASVs Greengenes2 places, ranked by its taxonomy; computed each time it's
  opened, nothing is stored.
</p>
