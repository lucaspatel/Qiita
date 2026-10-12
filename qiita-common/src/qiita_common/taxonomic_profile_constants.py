"""Taxonomic-profile constants shared across components.

The `taxonomic-profile` workflow's job (compute orchestrator) stages the DuckLake
table under this name; the control plane reads it back to serve a feature table.
Neither side can see the other's code, so the names live here.
"""

# One row per (prep_sample_idx, processing_idx, genome_idx) a profiler reported: its
# relative abundances, ANI and coverage.
TAXONOMIC_PROFILE_TABLE = "taxonomic_profile"

# register-files names a staged table after its file stem.
TAXONOMIC_PROFILE_BASENAME = f"{TAXONOMIC_PROFILE_TABLE}.parquet"

# The prep protocols a shotgun profiler reads. A pool's other samples (an ENA
# study's amplicon runs share its pool) are left out of the run, not refused.
METAGENOMIC_PREP_PROTOCOLS = ("short_read_metagenomics", "long_read_metagenomics")

# What a profiled genome's name reduces to: the `source_id` of a `qiita.genome` row
# of the database's sequence reference. sylph names a genome by the path it was
# sketched from (`.../G000802255.fna.gz`), so the key is the file name without its
# directory, its FASTA suffixes, and NCBI's `_genomic` (`GCA_000005845.2_genomic.fna.gz`
# is `GCA_000005845.2`). A DuckDB `regexp_replace` over that file name.
GENOME_FILE_SUFFIX_PATTERN = r"(_genomic)?\.(fna|fa|fasta|fas|ffn)(\.gz)?$"


def genome_source_id_sql(column: str) -> str:
    """The SQL reducing a profiler's genome name in `column` to a `source_id`."""
    return f"regexp_replace(regexp_extract({column}, '[^/]+$'), '{GENOME_FILE_SUFFIX_PATTERN}', '')"
