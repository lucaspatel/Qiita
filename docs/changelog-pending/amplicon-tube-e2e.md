### Added

- **A local stack: `make local-up`.** A private Postgres container, the data
  plane, control plane and orchestrator on its local backend, rooted under
  `~/.qiita-local/stack`, with a local-only admin and compute token bootstrap
  (docs/runbooks/local-stack.md). The local backend now runs `container:` steps
  under Docker when `LOCAL_CONTAINER_IMAGES` maps their SIF to a local image,
  following the same container contract as apptainer.
- **Amplicon samples get their public QM identifiers when a run loads.**
  `exported_identifier` gains its second processing kind, a `qiita.processing`
  run, and amplicon 1.1.0 ends with `mint-amplicon-identifiers`, which mints one
  per processed sample the run registered, as the submitter.
- **A work ticket can carry a follow-on (`on_success`).** `POST /work-ticket`
  accepts an `on_success` action and context; when the ticket completes, the
  control plane submits it as the same user on the same scope target. The
  follow-on is checked against its own action when the parent is submitted, so one
  that could never run is refused up front (`"on_success was refused"`). The
  created ticket's idx, or the reason a submission at completion was refused, is
  recorded on the parent (`follow_on_work_ticket_idx` / `follow_on_error`). A
  restart re-drives any follow-on left without an outcome. Human callers only.
- **`POST /biosample/resolve-roster` resolves a pool roster by matrix tube or
  accession.** One call takes every pool row (a matrix tube, or biosample and
  bioproject accessions) and returns each row's `biosample_idx` with its primary
  and secondary study. A tube resolves on its own, since tubes are unique across
  Qiita; its study comes from the biosample's active study links, and a project
  accession on the row must name one of them. A sheet's tube that lost its leading
  zero resolves to the stored 10-digit form. Any unresolved row refuses the whole
  roster with a 422 whose `detail` lists every problem (`malformed_tube`,
  `duplicate_tube`, `unknown_tube`, `identity_conflict`, `study_mismatch`,
  `no_study`, `ambiguous_study`, `no_identity`, `unknown_*_accession`).
- **`submit-golay-demux` accepts a pre-flight identified by matrix tube.** A
  pre-flight built straight from the pre-prep sheet carries each sample's tube and
  no accessions; the CLI now resolves its roster through `resolve-roster` and
  prints every problem against the sheet's `prepped_sample_idx`. The runner's
  roster check (`preflight.amplicon_samples`) accepts the same sheets. Needs
  run-preflight's `accept_tube_identity`, so the pin moves.
- **A feature table is a cohort query over one or more processing runs.**
  `POST /feature-table/{samples,values,features}` takes up to 32 `processing_idx` of one
  method — amplicon runs (whose trim and primer orientation must agree) or taxonomic
  profiles (against one database file and threshold) — and a study or a set of prepared
  samples. Columns are processed samples, named by ENA/BioSample accession when that is
  unique in the table and by QM otherwise; values are sparse COO in Arrow IPC (amplicon
  counts with md5 feature ids, whose features carry each ASV's sequence; profile relative
  abundances by genome name), and the samples answer names the method and `value_kind`.
  `POST .../ticket` returns signed Flight tickets, and `qiita feature-table runs` builds a
  BIOM or Parquet bundle from them.
- **`GET /study/{idx}/lineage` describes a study's processing as a graph.** One DAG per
  prep protocol (run, reads, mask, processing, product), with per-sample states backed by a
  new `qiita.amplicon_sample` gate, sample labels by accession, else QB, and each sample's
  `biosample_idx` for joining metadata. A sample whose reads have not landed shows its
  pool's ingest ticket state, from bcl-convert, golay-demux or an ENA download.

### Fixed

- **bcl-convert 4.x accepts the amplicon dummy sample sheet.** It refuses
  `CreateFastqForIndexReads` on a sheet with no index, so every amplicon run failed
  at bcl_convert. The sheet now declares the Golay read as a 12-cycle index and one
  placeholder sample whose index (`AAAAAAAAAAAA`) is beyond the Golay decoder's
  correctable radius, so every decodable read still reaches Undetermined with its I1.
- **The amplicon dummy sample sheet follows RunInfo.xml's read order.**
  bcl-convert reads `OverrideCycles` segments in the order RunInfo.xml lists the
  reads, but the sheet always wrote template/index/template, so a run that lists
  its index reads first (MiSeq i100) would mask its first template read and emit
  the index cycles as reads. The segments now follow the run's own order, and
  `[Reads]` carries each template read's own length.
- **`submit-bcl-convert` no longer crashes reading a real pre-flight.** The reader
  unpacked each `PlatformSampleInfo` as four values; the library returns more, so
  every real pre-flight failed with "too many values to unpack". It reads the
  record's fields by name, and the CLI tests stub the library's own record type.
- **`submit-bcl-convert` reports a pre-flight row missing an accession in the library's own
  words,** naming every offender, instead of calling the file an invalid SQLite.
