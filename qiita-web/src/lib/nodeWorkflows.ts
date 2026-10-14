// The workflows a lineage node can be run through. The DAG offers a "Run workflow"
// launcher off every node that at least one of these applies to; picking one shows
// its form, and, for one that `takes` samples, the node's table becomes a checklist
// of the samples it can take. A workflow with no `form` is listed but not yet
// submittable. Not every entry submits a ticket: a view (a filtered feature table)
// is read on demand and only adds a dashed node.
import type { Component } from 'svelte';
import type { LineageGroup, LineageNode, LineageSample } from './api';
import { isViewId, type TableView } from './tableViews';
import SylphProfileForm from './ui/SylphProfileForm.svelte';
import Greengenes2FilterForm from './ui/Greengenes2FilterForm.svelte';

export type WorkflowFormProps = {
  /** The node's group's samples. */
  samples: LineageSample[];
  /** The prep_samples ticked in the node's table: what a submission covers. */
  chosen: number[];
  /** The node it runs from. */
  node: LineageNode;
  /** Called once a submission is in, to reload the lineage. */
  onSubmitted: () => void;
  /** Adds a view of the node's table (for a workflow that makes one). */
  onView: (view: Omit<TableView, 'from'>) => void;
};

export type NodeWorkflow = {
  id: string;
  label: string;
  /** Why it can't be run yet, when it has no form. */
  note?: string;
  appliesTo: (node: LineageNode, group: LineageGroup) => boolean;
  /** Whether a sample can be submitted from this node, the rest unticked; absent
   *  for a workflow that doesn't run per sample, whose table stays as it is. */
  takes?: (sample: LineageSample, node: LineageNode) => boolean;
  form?: Component<WorkflowFormProps>;
};

// The prep protocols a shotgun profiler reads.
const METAGENOMIC_PROTOCOLS = ['short_read_metagenomics', 'long_read_metagenomics'];
const metagenomicReads = (n: LineageNode, g: LineageGroup) =>
  n.kind === 'reads' && METAGENOMIC_PROTOCOLS.includes(g.prep_protocol);
// A sample whose reads landed (the profiler streams stored reads).
const hasReads = (s: LineageSample, n: LineageNode) => s.cells[n.id]?.state === 'completed';
// A rapid-16S amplicon run's own feature table (not a view of one): V4 deblur
// ASVs, the only ones Greengenes2 places.
const ampliconTable = (n: LineageNode, g: LineageGroup) =>
  n.kind === 'product' && !isViewId(n.id) && g.prep_protocol.includes('amplicon');

export const NODE_WORKFLOWS: NodeWorkflow[] = [
  {
    id: 'taxonomic-profile-sylph',
    label: 'Taxonomic profile · sylph',
    appliesTo: metagenomicReads,
    takes: hasReads,
    form: SylphProfileForm
  },
  {
    id: 'taxonomic-profile-woltka',
    label: 'Taxonomic profile · woltka',
    note: 'not available yet',
    appliesTo: metagenomicReads,
    takes: hasReads
  },
  {
    id: 'filter-to-greengenes2',
    label: 'Filter to Greengenes2',
    appliesTo: ampliconTable,
    form: Greengenes2FilterForm
  }
];

export const workflowsFor = (n: LineageNode, g: LineageGroup) =>
  NODE_WORKFLOWS.filter((w) => w.appliesTo(n, g));
