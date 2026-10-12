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
                  abundances in percent and ANI as a fraction, as sylph reports
                  them, for register-files.
  profile_counts  (prep_sample_idx, genome_count), one row per sample with a
                  genome, outside the staging directory, for the closing action
                  (register-files moves the staged file into the lake).
"""

from __future__ import annotations

import json
import logging
import time
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

_LOG = logging.getLogger(__name__)

# How many sample idxs a log line or error names before it summarizes the rest.
_NAMED_SAMPLES = 20

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


def _named(idxs: list[int]) -> str:
    shown = ", ".join(map(str, idxs[:_NAMED_SAMPLES]))
    rest = len(idxs) - _NAMED_SAMPLES
    return shown + (f", … ({rest} more)" if rest > 0 else "")


def _check_streamed(conn, reads_rel: str, samples: list[int]) -> None:
    """Log what the read stream returned against what the runner asked for, and
    fail loud when it returned no read for any of them.

    The runner binds only samples with stored reads, so an empty result here is a
    fault in the stream or its scope, not an empty pool: ending as no_data would
    close every sample as having nothing to profile. A sample missing while others
    streamed is logged and closes 'no_data' at the finalize action."""
    streamed = dict(
        conn.execute(
            f"SELECT prep_sample_idx, count(*) FROM {reads_rel} GROUP BY 1 ORDER BY 1"
        ).fetchall()
    )
    total = sum(streamed.values())
    matched = sorted(set(streamed) & set(samples))
    missing = sorted(set(samples) - set(streamed))
    extra = sorted(set(streamed) - set(samples))
    _LOG.info(
        "read stream: %d reads over %d samples; %d of %d requested samples streamed",
        total,
        len(streamed),
        len(matched),
        len(samples),
    )
    if missing:
        _LOG.warning("requested samples with no streamed reads: %s", _named(missing))
    if extra:
        _LOG.info("streamed samples not profiled (not metagenomic): %s", _named(extra))
    if not matched:
        raise RuntimeError(
            f"the read stream returned no read for any of the {len(samples)} samples"
            f" bound for profiling ({_named(samples)}); it returned {total} reads over"
            f" {len(streamed)} other samples ({_named(sorted(streamed))}). Every bound"
            " sample has stored reads, so the stream or its scope is wrong"
        )


def _check_units(conn, sample_col: str) -> None:
    """Fail loud unless sylph reported abundances in percent and ANI as a fraction.

    The staged miint returns both abundances in [0, 100] (each sample's
    taxonomic_abundance summing to 100) and adjusted_ani in [0, 1], where its docs
    say the reverse. The lake stores them as reported, so a build that changes
    either unit must stop here rather than land rows a hundredfold off the rest."""
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
    _LOG.info(
        "profiling %d samples of pool %d (run %d) against %s (%d bytes); min_ani %s;"
        " duckdb %d GB, %d threads",
        len(samples),
        inputs.sequenced_pool_idx,
        inputs.sequencing_run_idx,
        database,
        database.stat().st_size,
        "sylph default" if inputs.min_ani is None else inputs.min_ani,
        memory_gb,
        _DUCKDB_THREADS,
    )

    with duckdb_tmp_dir(workspace) as duckdb_tmp, open_miint_conn() as conn:
        apply_duckdb_settings(conn, duckdb_tmp, memory_gb=memory_gb, threads=_DUCKDB_THREADS)
        async with bind_step_reads(
            conn,
            reads=inputs.reads,
            work_ticket_idx=inputs.work_ticket_idx,
            workspace=duckdb_tmp,
        ) as reads_rel:
            started = time.monotonic()
            _check_streamed(conn, reads_rel, samples)
            conn.execute(
                f"CREATE TABLE {_READS_TABLE} AS"
                " SELECT prep_sample_idx, read_id::VARCHAR AS read_id,"
                "        sequence1::VARCHAR AS sequence1, sequence2::VARCHAR AS sequence2"
                f" FROM {reads_rel} WHERE prep_sample_idx IN ({', '.join(map(str, samples))})"
            )
        _LOG.info("staged the reads in %.0fs", time.monotonic() - started)
        started = time.monotonic()
        conn.execute(
            "CREATE TABLE profile AS SELECT * FROM sylph_profile("
            f"{_sql_str(_READS_TABLE)}, {_sql_str(str(database))},"
            f" sample_id := 'prep_sample_idx'{options})"
        )
        _LOG.info("sylph_profile finished in %.0fs", time.monotonic() - started)
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
        per_sample = dict(
            conn.execute(
                f"SELECT {sample_col}::BIGINT, count(DISTINCT genome_name) FROM profile GROUP BY 1"
            ).fetchall()
        )
        unprofiled = sorted(set(samples) - set(per_sample))
        _LOG.info(
            "sylph reported %d genomes over %d samples (%d to %d per sample)",
            conn.execute("SELECT count(DISTINCT genome_name) FROM profile").fetchone()[0],
            len(per_sample),
            min(per_sample.values()),
            max(per_sample.values()),
        )
        if unprofiled:
            _LOG.warning("samples with no genome reported: %s", _named(unprofiled))
        # `genome_index` is left out: it is the genome's rank within the sample's
        # rows, not its offset in the database, so it identifies nothing.
        conn.execute(
            "COPY ("
            f"  SELECT {sample_col}::BIGINT AS prep_sample_idx,"
            f"         CAST({inputs.processing_idx} AS BIGINT) AS processing_idx,"
            "         genome_name, contig_name,"
            "         taxonomic_abundance, sequence_abundance,"
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
