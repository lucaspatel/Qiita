<script lang="ts">
  import { settings, saveSettings } from '$lib/settings.svelte';
  import PageHeading from '$lib/ui/PageHeading.svelte';
  import Card from '$lib/ui/Card.svelte';
</script>

<PageHeading title="Settings" subtitle="Client-side preferences — stored in this browser only." />

<Card title="Display">
  <div class="divide-y divide-gray-100">
    <label class="flex cursor-pointer items-start justify-between gap-4 py-3">
      <span>
        <span class="block text-sm font-medium text-gray-900">Humanize field labels</span>
        <span class="block text-xs text-gray-500">Title-case metadata field names (host_taxon_id → Host Taxon Id).</span>
      </span>
      <input
        type="checkbox"
        bind:checked={settings.humanizeLabels}
        onchange={saveSettings}
        class="mt-0.5 size-4 rounded border-gray-300 text-teal-600 focus:ring-teal-500"
      />
    </label>
    <label class="flex cursor-pointer items-start justify-between gap-4 py-3">
      <span>
        <span class="block text-sm font-medium text-gray-900">Remember recent studies</span>
        <span class="block text-xs text-gray-500">List studies you visit or create under "Recent studies".</span>
      </span>
      <input
        type="checkbox"
        bind:checked={settings.rememberRecents}
        onchange={saveSettings}
        class="mt-0.5 size-4 rounded border-gray-300 text-teal-600 focus:ring-teal-500"
      />
    </label>
  </div>
</Card>
