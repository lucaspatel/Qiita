"""Unit tests for the shared per-sample read-storage helpers (_read_storage.py).

`write_sorted_sample_reads` is the single writer `ingest_reads` and `golay_demux`
share. Both modes are pinned here:
  * default (`local_index_sql='sequence_index'`, no filter) — ingest_reads' shape,
    a per-sample intermediate keyed by miint's 1-based per-file index.
  * ROW_NUMBER + per-sample filter — golay_demux's shape, a pooled demux
    intermediate numbered across all samples that must be re-numbered per slice.
"""

from __future__ import annotations

import os
from pathlib import Path

import duckdb

from qiita_compute_orchestrator.jobs._read_storage import (
    hardlink,
    write_sorted_sample_reads,
)

_COLS = ["prep_sample_idx", "sequence_idx", "read_id", "sequence1", "qual1", "sequence2", "qual2"]


def _write_source(path: Path, rows: list[tuple], columns: list[str]) -> None:
    """Write a tiny source parquet from python rows via DuckDB. The index columns
    are BIGINT (the writer does arithmetic on the local index); the rest VARCHAR."""
    col_defs = ", ".join(
        f"{c} BIGINT" if c in ("sequence_index", "prep_sample_idx") else f"{c} VARCHAR"
        for c in columns
    )
    with duckdb.connect() as conn:
        conn.execute(f"CREATE TABLE src ({col_defs})")
        placeholders = ", ".join("?" for _ in columns)
        conn.executemany(f"INSERT INTO src VALUES ({placeholders})", rows)
        conn.execute(f"COPY src TO '{path}' (FORMAT PARQUET)")


def _read(path: Path) -> list[dict]:
    with duckdb.connect() as conn:
        cur = conn.execute(
            f"SELECT {', '.join(_COLS)} FROM read_parquet('{path}') ORDER BY sequence_idx"
        )
        names = [d[0] for d in cur.description]
        return [dict(zip(names, r)) for r in cur.fetchall()]


def test_default_mode_assigns_sequence_index_plus_offset(tmp_path):
    """ingest_reads' shape: sequence_idx = sequence_index + start - 1, verbatim."""
    src = tmp_path / "intermediate.parquet"
    # (sequence_index, read_id, sequence1, qual1, sequence2, qual2)
    _write_source(
        src,
        rows=[
            (1, "rA", "ACGT", "IIII", "TTTT", "JJJJ"),
            (2, "rB", "GGCC", "IIII", "AAAA", "JJJJ"),
            (3, "rC", "TTAA", "IIII", "CCCC", "JJJJ"),
        ],
        columns=["sequence_index", "read_id", "sequence1", "qual1", "sequence2", "qual2"],
    )
    out = tmp_path / "read.parquet"
    write_sorted_sample_reads(
        src,
        prep_sample_idx=42,
        sequence_idx_start=100,
        out_path=out,
        duckdb_tmp=tmp_path,
        memory_gb=1,
        threads=1,
    )
    rows = _read(out)
    assert [r["sequence_idx"] for r in rows] == [100, 101, 102]
    assert all(r["prep_sample_idx"] == 42 for r in rows)
    assert [r["read_id"] for r in rows] == ["rA", "rB", "rC"]
    # R2 carries through as sequence2/qual2.
    assert rows[0]["sequence2"] == "TTTT"
    # No stray .partial left behind.
    assert not (tmp_path / "read.parquet.partial").exists()


def test_golay_mode_renumbers_per_sample_slice(tmp_path):
    """golay's shape: a pooled source numbered across ALL samples. The ROW_NUMBER
    local index + per-sample filter must re-number this sample's slice densely
    1..count (then + start - 1), independent of the global sequence_index gaps."""
    src = tmp_path / "demuxed.parquet"
    # Two samples interleaved; sample 7's global sequence_index values are 2,4,5
    # (gappy) — the writer must still emit dense 1,2,3 for it.
    _write_source(
        src,
        rows=[
            (9, 1, "s9a", "AAAA", "IIII", None, None),
            (7, 2, "s7a", "CCCC", "IIII", None, None),
            (9, 3, "s9b", "GGGG", "IIII", None, None),
            (7, 4, "s7b", "TTTT", "IIII", None, None),
            (7, 5, "s7c", "ACAC", "IIII", None, None),
        ],
        columns=[
            "prep_sample_idx",
            "sequence_index",
            "read_id",
            "sequence1",
            "qual1",
            "sequence2",
            "qual2",
        ],
    )
    out = tmp_path / "read.parquet"
    write_sorted_sample_reads(
        src,
        prep_sample_idx=7,
        sequence_idx_start=500,
        out_path=out,
        duckdb_tmp=tmp_path,
        memory_gb=1,
        threads=1,
        local_index_sql="ROW_NUMBER() OVER (ORDER BY sequence_index)",
        where_sql="prep_sample_idx = 7",
    )
    rows = _read(out)
    # Only sample 7's three reads, densely re-numbered from the offset.
    assert [r["read_id"] for r in rows] == ["s7a", "s7b", "s7c"]
    assert [r["sequence_idx"] for r in rows] == [500, 501, 502]
    assert all(r["prep_sample_idx"] == 7 for r in rows)


def test_hardlink_shares_inode(tmp_path):
    src = tmp_path / "durable.parquet"
    src.write_bytes(b"payload-bytes")
    dst = tmp_path / "register" / "1.parquet"
    dst.parent.mkdir()
    hardlink(src, dst)
    assert dst.read_bytes() == b"payload-bytes"
    # Same inode: the register copy and the durable read share one on-disk file.
    assert os.stat(src).st_ino == os.stat(dst).st_ino


def test_hardlink_replaces_existing_dst(tmp_path):
    src = tmp_path / "durable.parquet"
    src.write_bytes(b"new")
    dst = tmp_path / "1.parquet"
    dst.write_bytes(b"stale")
    hardlink(src, dst)
    assert dst.read_bytes() == b"new"
    assert os.stat(src).st_ino == os.stat(dst).st_ino
