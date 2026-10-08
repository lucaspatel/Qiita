<script lang="ts">
  // The study's "Processing & data" section — the lineage DAG. The pools summary
  // (count · platform · samples) now lives in the study's Details tab.
  import StudyLineage from './StudyLineage.svelte';

  let { studyIdx }: { studyIdx: number } = $props();
</script>

<StudyLineage {studyIdx} />
