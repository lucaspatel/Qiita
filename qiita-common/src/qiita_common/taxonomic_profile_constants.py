"""Taxonomic-profile constants shared across components.

The `taxonomic-profile` workflow's job (compute orchestrator) stages the DuckLake
table under this name; the control plane reads it back to serve a feature table.
Neither side can see the other's code, so the names live here.
"""

# One row per (prep_sample_idx, processing_idx, genome) a profiler reported: its
# relative abundances, ANI and coverage.
TAXONOMIC_PROFILE_TABLE = "taxonomic_profile"

# register-files names a staged table after its file stem.
TAXONOMIC_PROFILE_BASENAME = f"{TAXONOMIC_PROFILE_TABLE}.parquet"

# The prep protocols a shotgun profiler reads. A pool's other samples (an ENA
# study's amplicon runs share its pool) are left out of the run, not refused.
METAGENOMIC_PREP_PROTOCOLS = ("short_read_metagenomics", "long_read_metagenomics")
