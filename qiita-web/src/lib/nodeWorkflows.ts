// The workflows a lineage node can be run through. The DAG offers a "Run workflow"
// launcher off every node that at least one of these applies to; picking one shows
// its form. A workflow with no `form` is listed but not yet submittable.
import type { Component } from 'svelte';
import type { LineageGroup, LineageNode, LineageSample } from './api';
import SylphProfileForm from './ui/SylphProfileForm.svelte';

export type WorkflowFormProps = {
  /** The node's group's samples, the ones a submission covers. */
  samples: LineageSample[];
  /** Called once a submission is in, to reload the lineage. */
  onSubmitted: () => void;
};

export type NodeWorkflow = {
  id: string;
  label: string;
  /** Why it can't be run yet, when it has no form. */
  note?: string;
  appliesTo: (node: LineageNode, group: LineageGroup) => boolean;
  form?: Component<WorkflowFormProps>;
};

// The prep protocols a shotgun profiler reads.
const METAGENOMIC_PROTOCOLS = ['short_read_metagenomics', 'long_read_metagenomics'];
const metagenomicReads = (n: LineageNode, g: LineageGroup) =>
  n.kind === 'reads' && METAGENOMIC_PROTOCOLS.includes(g.prep_protocol);

export const NODE_WORKFLOWS: NodeWorkflow[] = [
  {
    id: 'taxonomic-profile-sylph',
    label: 'Taxonomic profile · sylph',
    appliesTo: metagenomicReads,
    form: SylphProfileForm
  },
  {
    id: 'taxonomic-profile-woltka',
    label: 'Taxonomic profile · woltka',
    note: 'not available yet',
    appliesTo: metagenomicReads
  }
];

export const workflowsFor = (n: LineageNode, g: LineageGroup) =>
  NODE_WORKFLOWS.filter((w) => w.appliesTo(n, g));
