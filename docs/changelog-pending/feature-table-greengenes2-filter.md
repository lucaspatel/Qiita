### Added

- **A rapid-16S feature table can be filtered to the ASVs Greengenes2 places.** `POST
  /feature-table/{samples,values,features}` take `feature_filter: "greengenes2"`: the
  server joins the table's ASV md5s against the Greengenes2 ASV taxonomy named by the new
  optional `GREENGENES2_ASV_TAXONOMY_PATH` (a Parquet `scripts/greengenes2-asv-taxonomy.py`
  builds from the release), keeps the ASVs it places, and ranks them by its lineage.
  Computed on each read, nothing stored; a genome-keyed table refuses it (409), and a
  server without the file answers 503. `qiita feature-table runs --filter greengenes2`
  writes the filtered bundle with a taxonomy companion. The web lineage draws such a view
  as a dashed node off the feature table it reads, added from the "Run workflow" launcher;
  its PCoA leaves out samples with none of the placed ASVs and says how many.
