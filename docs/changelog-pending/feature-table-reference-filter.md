### Added

- **An amplicon feature table can be filtered to a reference's ASVs.** `POST
  /feature-table/{samples,values,features}` take an optional `filter_reference_idx`: the
  table keeps only the ASVs that are members of that active sequence reference (features
  are content-addressed, so an ASV identical to a reference sequence is that sequence's
  feature) and its features carry that reference's taxonomy. Computed on each read,
  nothing stored. A genome-keyed table refuses it (409). `qiita feature-table runs
  --filter-reference-idx` writes the filtered bundle with a taxonomy companion. The web
  lineage draws such a view as a dashed node off the feature table it reads, added from
  the "Run workflow" launcher; a filtered view's PCoA leaves out samples with none of the
  reference's ASVs and says how many.
