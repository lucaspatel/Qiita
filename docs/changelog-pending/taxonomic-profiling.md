### Added

- **Prebuilt profiling databases register where they sit.** `POST /reference/file`
  (system admin) and `qiita reference register-file` record a sylph `.syl2db` / `.syldb`
  as an active `profiling_database` reference with one `sylph` index row (path, format,
  sha256, size); the CLI hashes the file, the route checks it is a readable regular file of
  that size.
- **`taxonomic-profile` 1.0.0 profiles a pool's metagenomic samples with sylph.** One
  native step streams the pool's raw reads and runs miint's `sylph_profile` against a
  registered database (`sylph_reference_idx`, optional `min_ani` as a fraction), writing
  DuckLake `taxonomic_profile` (relative abundances in percent, ANI as a fraction, effective
  coverage, per sample and genome). Only the pool's short- and long-read metagenomic
  samples are profiled; a pool with none is refused. The run identity hashes the database
  reference, its file's sha256 and the threshold, so each method and database is its own
  run. A closing action records each sample in `qiita.taxonomic_profile_sample` and mints
  its QM. Reads are not host-filtered yet.
- **The study lineage branches per profile.** Each taxonomic-profile run is a "Taxonomic
  profile" node (detail: method, version, database) leading to its feature table, and a
  sample whose reads have not landed shows its pool's ENA download state.

### Changed

- **`/amplicon/feature-table/*` moved to `/feature-table/*`**, with `counts` renamed
  `values` (a `value` DOUBLE column) and the samples and ticket answers naming `method`
  and `value_kind`; `qiita feature-table amplicon` is now `qiita feature-table runs`. The
  web UI's PCoA hides rarefaction for relative-abundance tables and the grid shows them as
  percentages.
- **A run's feature table node appears once a sample completed**, so a run still pending
  no longer offers a table there is nothing in.
