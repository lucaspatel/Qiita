### Added

- **A sylph database registers as an index of the reference it was sketched from.**
  `POST /reference/file` (system admin) and `qiita reference register-file --reference-idx
  <ref> --path <file> [--label ani95]` record a `.syl2db` / `.syldb` as a `sylph` index row
  (path, format, sha256, size, label) of an active sequence reference with genomes; a
  reference may carry several (one per ANI threshold, say). The CLI hashes the file, the
  route checks it is a readable regular file of that size.
- **`taxonomic-profile` 1.0.0 profiles a pool's metagenomic samples with sylph.** One
  native step streams the pool's raw reads and runs miint's `sylph_profile` against a
  registered database (`sylph_index_idx`, optional `min_ani` as a fraction), resolves each
  genome it reports to its reference's `genome_idx` (a genome the reference lacks fails
  the step), and writes DuckLake `taxonomic_profile` (relative abundances in percent, ANI
  as a fraction, effective coverage, per sample and genome). Only the pool's short- and long-read metagenomic
  samples with stored reads are profiled; a pool with none is refused. A read stream that
  returns none of those samples fails the step instead of ending as no data, and the step
  log records what was requested, what streamed, and per-stage timings. The run identity
  hashes the database's reference, its file's sha256 and the threshold, so each method and
  database is its own run. A closing action records each sample in `qiita.taxonomic_profile_sample` and mints
  its QM. Reads are not host-filtered yet.
- **The study lineage branches per profile.** Each taxonomic-profile run is a "Taxonomic
  profile" node (detail: method, version, reference and database label) leading to its
  feature table, and a
  sample whose reads have not landed shows its pool's ENA download state.

### Changed

- **`/amplicon/feature-table/*` moved to `/feature-table/{samples,values,features}`**, with
  `counts` renamed `values` (a `value` DOUBLE column) and the samples answer naming
  `method` and `value_kind`. A profile's features are its genomes, named by their
  `exported_feature` handles (the accession wherever it is free) as an alignment-based
  table names them, and carry the reference's taxonomy as the eight rank columns of the
  alignment taxonomy sidecar, reduced per genome by the same SQL. The `ticket` answer is
  gone: `qiita feature-table amplicon` is now `qiita feature-table runs`, which writes its
  bundle (with ASV sequences, or genome taxonomy) from the same routes the web UI reads,
  and no longer takes `--data-plane-url`. The web UI's PCoA hides rarefaction for
  relative-abundance tables and the grid shows them as percentages.
- **A run's feature table node appears once a sample completed**, so a run still pending
  no longer offers a table there is nothing in.

### Fixed

- **Closing a run's per-sample status touches only the ticket's own samples.** Amplicon
  and taxonomic-profile runs are keyed on their parameters, not the pool, so two pools
  processed alike share a run; closing one ticket, or ending it as no data, used to mark
  the other pool's still-running samples `no_data`.
- **Native jobs' log lines reach the step log.** The job launcher sends INFO-and-above
  logging to stderr, which SLURM captures and the step-log route serves.
