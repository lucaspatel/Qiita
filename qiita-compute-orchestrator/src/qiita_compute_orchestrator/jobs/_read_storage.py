"""Shared per-sample read-storage helpers for the read-ingest jobs.

`ingest_reads` (the bcl-convert / fastq-handoff storage half) and `golay_demux`
both, per sample, assign a minted `sequence_idx` to a source of that sample's
reads and write the durable, sorted `read.parquet`, then hardlink it into the
register staging dir. The write + link are identical bar how each derives the
per-sample local index:

- ingest_reads' source is a *per-sample* intermediate keyed by miint's 1-based
  per-file `sequence_index`, so the local index is that column verbatim.
- golay_demux's source is a *pooled* demux intermediate numbered across ALL
  samples, so it re-numbers each sample's slice with
  `ROW_NUMBER() OVER (ORDER BY sequence_index)` under a per-sample filter.

Rather than copy the COPY into each job, the write lives here once, parameterized
by that local-index expression and an optional per-sample filter. Neither caller
materializes reads through FASTQ to reach this seam — both already hold their
reads in a Parquet — so sharing the writer adds no I/O.
"""

from __future__ import annotations

import os
from pathlib import Path

from qiita_common.parquet import validate_parquet_path

from ..miint import PARQUET_OPTS, apply_duckdb_settings, open_conn


def write_sorted_sample_reads(
    source_parquet: Path,
    *,
    prep_sample_idx: int,
    sequence_idx_start: int,
    out_path: Path,
    duckdb_tmp: Path,
    memory_gb: int,
    threads: int,
    local_index_sql: str = "sequence_index",
    where_sql: str | None = None,
) -> None:
    """Assign `sequence_idx` and write one sample's durable read.parquet, atomically.

    `source_parquet` carries `(read_id, sequence1, qual1, sequence2, qual2)` plus
    whatever `local_index_sql` / `where_sql` reference. The output columns are
    `(prep_sample_idx, sequence_idx, read_id, sequence1, qual1, sequence2, qual2)`
    with `sequence_idx = local_index_sql + sequence_idx_start - 1`.

    `local_index_sql` is the per-sample 1-based row index: ingest_reads passes the
    default `sequence_index` (miint's per-file index); golay passes
    `ROW_NUMBER() OVER (ORDER BY sequence_index)` because its pooled demux
    intermediate numbers reads across all samples. `where_sql` restricts a pooled
    source to one sample's slice (golay: `prep_sample_idx = <int>`), or is None for
    an already-per-sample source. Both are trusted, caller-built SQL fragments (not
    user input); a caller interpolating a value MUST cast it (golay uses an int).

    The explicit ORDER BY is load-bearing: `apply_duckdb_settings` runs with
    `preserve_insertion_order=false`, so only the sort guarantees `sequence_idx` is
    ordered at rest (for DuckLake pruning / row-group pushdown). Atomic publish: the
    COPY lands in a `.partial` sibling then `os.replace`s into `out_path` — which
    doubles as the caller's idempotency sentinel, so it must only ever appear
    complete (DuckDB `COPY ... TO` is not atomic; an OOM/walltime cut mid-COPY would
    otherwise strand a truncated file the next attempt skips).
    """
    where_clause = f" WHERE {where_sql}" if where_sql else ""
    partial_path = out_path.parent / f"{out_path.name}.partial"
    partial = validate_parquet_path(partial_path)
    try:
        with open_conn() as conn:
            apply_duckdb_settings(conn, duckdb_tmp, memory_gb=memory_gb, threads=threads)
            conn.execute(
                "COPY ( SELECT "
                "  ?::BIGINT AS prep_sample_idx,"
                f"  {local_index_sql} + ? - 1 AS sequence_idx,"
                "  read_id, sequence1, qual1, sequence2, qual2 "
                f"FROM read_parquet(?){where_clause} "
                "ORDER BY sequence_idx ) "
                f"TO '{partial}' ({PARQUET_OPTS})",
                [prep_sample_idx, sequence_idx_start, str(source_parquet)],
            )
        # Publish atomically: the durable path only ever appears complete.
        os.replace(partial_path, out_path)
    finally:
        # If the COPY died before the replace, drop the half-written partial so a
        # retry re-derives instead of finding stale bytes.
        partial_path.unlink(missing_ok=True)


def hardlink(src: Path, dst: Path) -> None:
    """Hardlink `src` -> `dst` (the register staging copy shares one inode with the
    durable read.parquet), falling back to a copy across filesystems."""
    dst.unlink(missing_ok=True)
    try:
        os.link(src, dst)
    except OSError:
        import shutil  # noqa: PLC0415

        shutil.copyfile(src, dst)
