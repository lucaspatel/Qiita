"""Taxonomic profiling of a pool's raw shotgun reads with sylph, as a native miint job.

miint's `sylph_profile` sketches each sample's reads and reports, per genome of a
sylph database it found, the sample's relative abundances, ANI and coverage. The
database is a registered `profiling_database` reference's file, bound by the
runner; the samples are the pool's metagenomic ones, also bound by the runner
(an ENA study's amplicon runs share its pool and are left out).

TODO: profile host-filtered reads rather than raw ones. A rype host-filter pass
belongs in front of this step for metagenomic preps; host reads mostly match no
microbial genome, so raw reads skew sequence_abundance down rather than adding
false genomes.

Outputs:
  staging_dir     <staging>/taxonomic_profile.parquet, the DuckLake table rows
                  (prep_sample_idx, processing_idx, genome_name, contig_name,
                  taxonomic_abundance, sequence_abundance, adjusted_ani, eff_cov),
                  abundances and ANI as fractions in [0, 1], for register-files.
  profile_counts  (prep_sample_idx, genome_count), one row per sample with a
                  genome, outside the staging directory, for the closing action
                  (register-files moves the staged file into the lake).
"""

from __future__ import annotations

import json
from pathlib import Path

from pydantic import BaseModel, Field
from qiita_common.backend_failure import StepNoData
from qiita_common.parquet import validate_parquet_path
from qiita_common.taxonomic_profile_constants import TAXONOMIC_PROFILE_BASENAME

from ..miint import (
    PARQUET_OPTS,
    apply_duckdb_settings,
    duckdb_tmp_dir,
    open_miint_conn,
    resolve_duckdb_memory_gb,
)
from ..read_source import bind_step_reads

YAML_STEP_NAME = "profile"

# sylph's sketching runs in-process beside DuckDB and shares this job's memory; a
# two-stage database keeps only its screen index resident, so the reserve is for
# the per-sample sketches.
_DUCKDB_THREADS = 8
_DUCKDB_FALLBACK_MEMORY_GB = 8
_DUCKDB_RESERVE_GB = 16

# The rows sylph_profile's per-sample branch reads must be a regular table: that
# branch binds on a helper connection that cannot see TEMP tables, views over
# registered relations, or streams (duckdb-miint#207).
_READS_TABLE = "profile_reads"


class Inputs(BaseModel):
    """Typed input contract for the profiling step.

    reads: unset in practice; the pool's reads stream from the data plane.
    sylph_database: the registered sylph `.syl2db`/`.syldb`, bound by the runner.
    profile_samples: JSON list of the prep_sample_idx to profile, bound by the runner.
    processing_idx: the run identity, threaded via the step's `params:`.
    min_ani: sylph's minimum adjusted ANI, a fraction in [0, 1], to report a
        genome; unset is sylph's default.
    """

    reads: Path | None = None
    sylph_database: Path
    profile_samples: Path
    processing_idx: int
    min_ani: float | None = Field(default=None, ge=0, le=1)
    sequenced_pool_idx: int
    sequencing_run_idx: int
    work_ticket_idx: int


def _sql_str(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _check_units(conn, sample_col: str) -> None:
    """Fail loud unless sylph reported abundances in percent and ANI as a fraction.

    The staged miint returns both abundances in [0, 100] (each sample's
    taxonomic_abundance summing to 100) and adjusted_ani in [0, 1], where its docs
    say the reverse. The job converts abundances to fractions, so a build that
    changes either unit must stop here rather than land rows a hundredfold off."""
    worst = conn.execute(
        "SELECT max(abs(total - 100)), max(ani) FROM ("
        f"  SELECT sum(taxonomic_abundance) AS total, max(adjusted_ani) AS ani"
        f"  FROM profile GROUP BY {sample_col})"
    ).fetchone()
    if worst[0] > 1.0:
        raise RuntimeError(
            "sylph_profile's taxonomic_abundance no longer sums to 100 per sample"
            f" (off by up to {worst[0]:.3f}); its unit changed"
        )
    if worst[1] > 1.0:
        raise RuntimeError(
            f"sylph_profile's adjusted_ani exceeds 1 ({worst[1]}); it is no longer a fraction"
        )


async def execute(inputs: Inputs, workspace: Path) -> dict[str, Path]:
    workspace = workspace.resolve()
    database = inputs.sylph_database.resolve()
    if not database.is_file():
        raise FileNotFoundError(f"sylph database not found: {database}")
    samples = json.loads(inputs.profile_samples.read_text())
    if not samples or not all(type(s) is int and s > 0 for s in samples):
        raise ValueError(f"profile_samples must be a non-empty list of idxs, got {samples!r}")

    workspace.mkdir(parents=True, exist_ok=True)
    staging = workspace / "taxonomic_profile_staging"
    staging.mkdir(parents=True, exist_ok=True)
    profile_out = validate_parquet_path(staging / TAXONOMIC_PROFILE_BASENAME)
    counts_out = validate_parquet_path(workspace / "profile_counts.parquet")
    memory_gb = resolve_duckdb_memory_gb(
        _DUCKDB_FALLBACK_MEMORY_GB, threads=_DUCKDB_THREADS, reserve_gb=_DUCKDB_RESERVE_GB
    )
    options = f", min_ani := {float(inputs.min_ani)}" if inputs.min_ani is not None else ""

    with duckdb_tmp_dir(workspace) as duckdb_tmp, open_miint_conn() as conn:
        apply_duckdb_settings(conn, duckdb_tmp, memory_gb=memory_gb, threads=_DUCKDB_THREADS)
        async with bind_step_reads(
            conn,
            reads=inputs.reads,
            work_ticket_idx=inputs.work_ticket_idx,
            workspace=duckdb_tmp,
        ) as reads_rel:
            conn.execute(
                f"CREATE TABLE {_READS_TABLE} AS"
                " SELECT prep_sample_idx, read_id::VARCHAR AS read_id,"
                "        sequence1::VARCHAR AS sequence1, sequence2::VARCHAR AS sequence2"
                f" FROM {reads_rel} WHERE prep_sample_idx IN ({', '.join(map(str, samples))})"
            )
        if conn.execute(f"SELECT count(*) FROM {_READS_TABLE}").fetchone()[0] == 0:
            raise StepNoData(
                step_name=YAML_STEP_NAME, reason="the pool's metagenomic samples have no reads"
            )
        conn.execute(
            "CREATE TABLE profile AS SELECT * FROM sylph_profile("
            f"{_sql_str(_READS_TABLE)}, {_sql_str(str(database))},"
            f" sample_id := 'prep_sample_idx'{options})"
        )
        # The per-sample branch prepends the partition column. miint documents it
        # as the named column in one place and as `sample_id` in another; the
        # staged build names it `sample_id`.
        columns = [r[0] for r in conn.execute("DESCRIBE profile").fetchall()]
        sample_col = "prep_sample_idx" if "prep_sample_idx" in columns else "sample_id"
        if sample_col not in columns:
            raise RuntimeError(f"sylph_profile returned no sample column: {columns}")
        if conn.execute("SELECT count(*) FROM profile").fetchone()[0] == 0:
            raise StepNoData(
                step_name=YAML_STEP_NAME, reason="sylph found no database genome in any sample"
            )
        _check_units(conn, sample_col)
        # Abundances to fractions, the unit ANI already has. `genome_index` is
        # left out: it is the genome's rank within the sample's rows, not its
        # offset in the database, so it identifies nothing.
        conn.execute(
            "COPY ("
            f"  SELECT {sample_col}::BIGINT AS prep_sample_idx,"
            f"         CAST({inputs.processing_idx} AS BIGINT) AS processing_idx,"
            "         genome_name, contig_name,"
            "         taxonomic_abundance / 100.0 AS taxonomic_abundance,"
            "         sequence_abundance / 100.0 AS sequence_abundance,"
            "         adjusted_ani, eff_cov"
            "  FROM profile ORDER BY prep_sample_idx, genome_name"
            f") TO '{profile_out}' ({PARQUET_OPTS})"
        )
        conn.execute(
            "COPY ("
            f"  SELECT {sample_col}::BIGINT AS prep_sample_idx,"
            "         count(DISTINCT genome_name)::INTEGER AS genome_count"
            f"  FROM profile GROUP BY 1 ORDER BY 1"
            f") TO '{counts_out}' ({PARQUET_OPTS})"
        )

    return {"staging_dir": staging, "profile_counts": Path(counts_out)}
