### Fixed

- **Deleting a reference no longer deletes feature rows an amplicon table uses.**
  `DELETE /reference/{idx}` deleted every `qiita.feature` (with its `feature_genome`
  and genome) that no other reference, annotation or assembly claimed. An amplicon
  ASV identical to a reference sequence is the same content-addressed feature, but its
  counts live only in DuckLake, so the delete removed the row they name, and a later
  load of the same bytes minted a new `feature_idx` they never match. Features,
  feature→genome mappings and genomes are now kept; `orphan_feature_count` still
  reports the features no surviving reference or assembly claims, and the data plane
  still drops their `reference_sequences` copies.
