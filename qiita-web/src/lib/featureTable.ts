// A run feature table in the browser — an amplicon run's ASV counts or a taxonomic
// profile's relative abundances: the server's sparse COO (Arrow IPC) plus its
// column sidecar, held as integer codes. Nothing here densifies; views (the grid's
// visible window, the PCoA's matrix) do that for what they show.
import { tableFromIPC } from 'apache-arrow';
import { api, type ApiResult, type FeatureTableRequest, type FeatureTableValueKind } from './api';

export type FeatureTable = {
  /** The runs' method (`amplicon`, `taxonomic-profile`). */
  method: string;
  /** Counts (rarefiable) or relative abundances (percent; not rarefiable). */
  valueKind: FeatureTableValueKind;
  /** Column names, by code: a processed sample's accession, else its QM. */
  samples: string[];
  /** Column name -> the biosample's public name (the metadata join key). */
  biosampleOf: Record<string, string>;
  /** Column name -> the processed sample's QM. */
  exportIdOf: Record<string, string>;
  /** Feature ids (an ASV's sequence md5, or a genome's accession), by code. */
  features: string[];
  /** Feature id -> its ASV sequence; empty for a profile. */
  sequenceOf: Map<string, string>;
  /** Feature id -> a genome's lineage (`d__...;s__...`), its named ranks from its
   *  reference's taxonomy; empty for an amplicon table. */
  taxonomyOf: Map<string, string>;
  /** The observations: sample code, feature code, value, one per nonzero cell. */
  s: Int32Array;
  f: Int32Array;
  c: Float64Array;
};

function codes(values: ArrayLike<string>, names: string[], index: Map<string, number>): Int32Array {
  const out = new Int32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    let k = index.get(v);
    if (k === undefined) {
      k = names.length;
      names.push(v);
      index.set(v, k);
    }
    out[i] = k;
  }
  return out;
}

/** Fetch and assemble the table `request` names: its columns, values and features. */
export async function loadFeatureTable(
  request: FeatureTableRequest
): Promise<ApiResult<FeatureTable>> {
  const [cols, counts, feats] = await Promise.all([
    api.featureTableSamples(request),
    api.featureTableValues(request),
    api.featureTableFeatures(request)
  ]);
  if (!cols.ok) return cols;
  if (!counts.ok) return counts;
  if (!feats.ok) return feats;

  // Columns in the sidecar's order, so a column with no observation still exists.
  const samples = cols.data.samples.map((x) => x.sample);
  const sampleIndex = new Map(samples.map((n, i) => [n, i]));
  const features: string[] = [];
  const featureIndex = new Map<string, number>();

  const coo = tableFromIPC(counts.data);
  const s = codes(coo.getChild('sample')!.toArray() as string[], samples, sampleIndex);
  const f = codes(coo.getChild('feature')!.toArray() as string[], features, featureIndex);
  const c = Float64Array.from(coo.getChild('value')!.toArray() as ArrayLike<number>);
  if (samples.length !== cols.data.samples.length)
    throw new Error('the values name a sample the sidecar does not');

  const ft = tableFromIPC(feats.data);
  const ids = ft.getChild('feature')!.toArray() as string[];
  const seqs = ft.getChild('sequence')!.toArray() as string[];
  // The eight rank columns, coarsest first, each prefixed (`d__Bacteria`).
  const ranks = RANKS.map((r) => ft.getChild(r)?.toArray() as (string | null)[] | undefined);
  const sequenceOf = new Map<string, string>();
  const taxonomyOf = new Map<string, string>();
  for (let i = 0; i < ids.length; i++) {
    if (seqs[i] != null) sequenceOf.set(ids[i], seqs[i]);
    const named = ranks.map((col) => col?.[i]).filter((x): x is string => !!x);
    if (named.length) taxonomyOf.set(ids[i], named.join(';'));
  }

  return {
    ok: true,
    status: 200,
    data: {
      method: cols.data.method,
      valueKind: cols.data.value_kind,
      samples,
      biosampleOf: Object.fromEntries(cols.data.samples.map((x) => [x.sample, x.biosample])),
      exportIdOf: Object.fromEntries(cols.data.samples.map((x) => [x.sample, x.export_id])),
      features,
      sequenceOf,
      taxonomyOf,
      s,
      f,
      c
    }
  };
}

/** The features route's rank columns, coarsest first. */
const RANKS = ['domain', 'phylum', 'class', 'order', 'family', 'genus', 'species', 'strain'];

/** A genome's display name: the species of its lineage, else its lowest named
 *  rank (`g__Nonomuraea` -> "Nonomuraea (genus)"), else its accession. */
export function genomeLabel(table: FeatureTable, feature: string): string {
  const lineage = table.taxonomyOf.get(feature);
  if (!lineage) return feature;
  const ranks: Record<string, string> = {
    s: 'species',
    g: 'genus',
    f: 'family',
    o: 'order',
    c: 'class',
    p: 'phylum',
    d: 'domain'
  };
  const named = lineage
    .split(';')
    .map((t) => t.trim().match(/^([a-z])__(.+)$/))
    .filter((m): m is RegExpMatchArray => m != null && m[2].trim() !== '');
  const last = named.at(-1);
  if (!last) return feature;
  return last[1] === 's' ? last[2] : `${last[2]} (${ranks[last[1]] ?? last[1]})`;
}

/** `table` without the samples that have no observation, and their names. A table
 *  filtered to a reference's ASVs can leave a sample with none of them, which an
 *  ordination cannot place. */
export function dropEmptySamples(table: FeatureTable): { table: FeatureTable; dropped: string[] } {
  const seen = new Uint8Array(table.samples.length);
  for (const k of table.s) seen[k] = 1;
  if (seen.every(Boolean)) return { table, dropped: [] };
  const remap = new Int32Array(table.samples.length).fill(-1);
  const samples: string[] = [];
  const dropped: string[] = [];
  table.samples.forEach((name, i) => {
    if (seen[i]) {
      remap[i] = samples.length;
      samples.push(name);
    } else dropped.push(name);
  });
  return { table: { ...table, samples, s: table.s.map((k) => remap[k]) }, dropped };
}
