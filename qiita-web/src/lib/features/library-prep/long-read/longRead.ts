// MOCKUP data + types for the long-read (PacBio Revio) amplicon branch of Library
// prep. Unlike the short-read flow, there are no plates and no Golay barcodes: the
// pool is multiplexed with PacBio barcodes, demultiplexed upstream in SMRTlink, so
// the prep is a barcode→sample map (Serena's file) plus the run's protocol facts.
//
// The crucial difference from short-read: this branch does NOT build a pre-prep
// sample sheet that kl-run-preflight then launders. It collects the pre-flight's
// native fields directly and (in the real flow) posts them to the control plane,
// which calls kl-run-preflight's typed builders to author the pre-flight blob.
// Local data only; nothing is sent.

/** One multiplexed sample in the pool: its PacBio barcode and its identity. */
export type PoolSample = {
  sample_name: string;
  /** PacBio barcode that demultiplexes this sample (SMRTlink, upstream). */
  barcode_id: string;
  /** Physical matrix tube — the identity Qiita-miint resolves to a biosample. */
  tube: string;
  /** What Qiita-miint resolves the tube to, filled on "scan". */
  study?: string;
  sample_type: 'standard' | 'control';
};

/** The run's protocol facts — constant across the pool. These are the ONLY new
 *  per-run facts the pre-flight needs for long-read amplicons beyond a normal
 *  PacBio run: the primer pair(s), the UMI pattern, and the target region. */
export type Protocol = {
  /** 16S full-length amplification primers. Short term: a single pair. */
  fwd_primer: string;
  rev_primer: string;
  /** The 5'/3' construct primers flanking the UMIs (adapters stripped in
   *  processing). Kept for provenance; rrna-operon detects the UMIs itself. */
  five_prime_primer: string;
  three_prime_primer: string;
  /** The permissive UMI pattern (part of the protocol, per-run). */
  umi_pattern: string;
  target_gene: string;
  target_subfragment: string;
};

/** Revio run facts, from whoever ran the instrument. */
export type RunFacts = {
  instrument_model: string;
  run_date: string;
  smrt_cell_well: string;
  movie_context: string;
};

export const STUDIES: Record<string, { title: string; color: string }> = {
  '14458': { title: 'Gut rRNA operon survey', color: '#2563eb' },
  '14712': { title: 'Marine full-length 16S', color: '#059669' }
};
export const OTHER = 'other';

/** The Karst et al 2021 rRNA-operon prep: the ~5 Kbp 16S–ITS–23S amplicon tagged
 *  with per-molecule UMIs, amplified on the universal-tail adapters. Locus primers
 *  are 16S 8F (fwd) and 23S 2490R (rev); the construct primers are the 24-bp
 *  universal tails flanking the 18-bp UMIs. Values are the lab's. */
export const PROTOCOL_KARST_5KB: Protocol = {
  fwd_primer: 'AGRGTTYGATYMTGGCTCAG', // lu_16S_8F locus
  rev_primer: 'CGACATCGAGGTGCCAAAC', // lu_23S_2490R locus
  five_prime_primer: 'CAAGCAGAAGACGGCATACGAGAT', // fwd universal tail / PCR2 primer
  three_prime_primer: 'AATGATACGGCGACCACCGAGATC', // rev universal tail / PCR2 primer
  umi_pattern: 'NNNYRNNNYRNNNYRNNN',
  target_gene: '16S-ITS-23S rRNA operon',
  target_subfragment: 'full-length (16S–23S, ~5 Kbp)'
};

/** A small demo pool: 8 samples across two studies + one blank, each with a
 *  distinct PacBio barcode (bc1001..). Mirrors "Serena dropped off a barcode map". */
export const DEMO_POOL: PoolSample[] = [
  { sample_name: 'GUT.01', barcode_id: 'bc1001', tube: '0363157901', study: '14458', sample_type: 'standard' },
  { sample_name: 'GUT.02', barcode_id: 'bc1002', tube: '0363157902', study: '14458', sample_type: 'standard' },
  { sample_name: 'GUT.03', barcode_id: 'bc1003', tube: '0363157903', study: '14458', sample_type: 'standard' },
  { sample_name: 'MAR.01', barcode_id: 'bc1004', tube: '0363157904', study: '14712', sample_type: 'standard' },
  { sample_name: 'MAR.02', barcode_id: 'bc1005', tube: '0363157905', study: '14712', sample_type: 'standard' },
  { sample_name: 'MAR.03', barcode_id: 'bc1006', tube: '0363157906', study: '14712', sample_type: 'standard' },
  { sample_name: 'GUT.04', barcode_id: 'bc1007', tube: '0363157907', study: '14458', sample_type: 'standard' },
  { sample_name: 'BLANK.01', barcode_id: 'bc1008', tube: '0363157908', study: OTHER, sample_type: 'control' }
];

export const DEMO_RUN: RunFacts = {
  instrument_model: 'Revio',
  run_date: '',
  smrt_cell_well: '1_B01',
  movie_context: 'm84137_260717_104358_s3'
};

/** Problems that would block authoring the pre-flight — the long-read analogues of
 *  the short-read barcode-clash check. A PacBio barcode must demultiplex exactly
 *  one sample, so a barcode on two rows is fatal; a missing barcode or identity is
 *  too. (A tube may still REPEAT as a technical replicate — that is fine, and
 *  resolves to the same biosample, as the roster resolver now allows.) */
export function poolProblems(pool: PoolSample[]): string[] {
  const problems: string[] = [];
  const byBarcode = new Map<string, number>();
  for (const s of pool) {
    byBarcode.set(s.barcode_id, (byBarcode.get(s.barcode_id) ?? 0) + 1);
    if (!s.barcode_id) problems.push(`${s.sample_name}: no PacBio barcode`);
    if (!s.tube) problems.push(`${s.sample_name}: no matrix tube`);
  }
  for (const [bc, n] of byBarcode) {
    if (n > 1) problems.push(`barcode ${bc} demultiplexes ${n} samples — each barcode must be unique in the pool`);
  }
  return problems;
}

/** A human-readable preview of the typed-builder calls the control plane would make
 *  — this is the "authored directly" artifact, standing in for the pre-prep sheet. */
export function builderPreview(pool: PoolSample[], protocol: Protocol, run: RunFacts): string {
  const lines: string[] = [];
  lines.push(`run = create_run(conn, platform="PacBio", assay="Amplicon",`);
  lines.push(`                 instrument=${q(run.instrument_model)}, run_date=${q(run.run_date)})`);
  for (const s of pool) {
    lines.push(
      `add_pacbio_sample(conn, run, sample_name=${q(s.sample_name)}, identity=Tube(${q(s.tube)}),`
    );
    lines.push(
      `                  barcode_id=${q(s.barcode_id)}, smrt_cell_well=${q(run.smrt_cell_well)}, movie=${q(run.movie_context)})`
    );
  }
  lines.push(`set_amplicon_details(conn, run,`);
  lines.push(`                     primer=${q(protocol.fwd_primer)}, pcr_primers=${q(`FWD:${protocol.fwd_primer}; REV:${protocol.rev_primer}`)},`);
  lines.push(`                     target_gene=${q(protocol.target_gene)}, target_subfragment=${q(protocol.target_subfragment)},`);
  lines.push(`                     umi_pattern=${q(protocol.umi_pattern)}, barcodes_are_rc=None)`);
  return lines.join('\n');
}

const q = (s: string) => `"${s}"`;
