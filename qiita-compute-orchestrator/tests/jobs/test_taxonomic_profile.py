"""taxonomic_profile against a real sylph database built from synthetic genomes."""

from __future__ import annotations

import json
import random

import duckdb
import pytest
from pydantic import ValidationError

from qiita_compute_orchestrator.jobs.taxonomic_profile import Inputs, execute
from qiita_compute_orchestrator.miint import open_miint_conn

_SCOPE = {"sequenced_pool_idx": 1, "sequencing_run_idx": 1, "work_ticket_idx": 1}
_GENOME_BP = 200_000
_READ_BP = 150


@pytest.fixture(scope="module")
def genomes():
    rng = random.Random(1)
    return {f"G{i:03d}": "".join(rng.choice("ACGT") for _ in range(_GENOME_BP)) for i in range(3)}


@pytest.fixture(scope="module")
def syl2db(genomes, tmp_path_factory):
    path = tmp_path_factory.mktemp("sylph") / "synthetic.syl2db"
    with open_miint_conn() as con:
        con.execute(
            "CREATE TABLE refs (read_id VARCHAR, sequence1 VARCHAR, genome VARCHAR,"
            " sequence_index BIGINT)"
        )
        con.executemany(
            "INSERT INTO refs VALUES (?, ?, ?, 0)",
            [(f"{g}_c1", seq, g) for g, seq in genomes.items()],
        )
        con.execute(f"SELECT * FROM sylph_index_create('refs', '{path}', genome_id := 'genome')")
    return path


def _reads(genomes, tmp_path, mixes):
    """A read_block-shaped parquet: per sample, reads drawn from its genome mix."""
    rng = random.Random(2)
    rows = []
    for prep_sample_idx, mix in mixes.items():
        for n in range(30_000):
            g = rng.choices(list(mix), weights=list(mix.values()))[0]
            start = rng.randrange(0, _GENOME_BP - _READ_BP)
            rows.append(
                (
                    prep_sample_idx,
                    n,
                    f"r{prep_sample_idx}_{n}",
                    genomes[g][start : start + _READ_BP],
                )
            )
    path = tmp_path / "reads.parquet"
    with duckdb.connect() as con:
        con.execute(
            "CREATE TABLE r (prep_sample_idx BIGINT, sequence_idx BIGINT, read_id VARCHAR,"
            " sequence1 VARCHAR)"
        )
        con.executemany("INSERT INTO r VALUES (?, ?, ?, ?)", rows)
        con.execute(
            "COPY (SELECT *, NULL::VARCHAR AS qual1, NULL::VARCHAR AS sequence2,"
            f" NULL::VARCHAR AS qual2 FROM r) TO '{path}' (FORMAT PARQUET)"
        )
    return path


def _inputs(tmp_path, reads, syl2db, samples, **kw):
    samples_path = tmp_path / "profile_samples.json"
    samples_path.write_text(json.dumps(samples))
    return Inputs(
        reads=reads,
        sylph_database=syl2db,
        profile_samples=samples_path,
        processing_idx=77,
        **_SCOPE,
        **kw,
    )


async def test_profiles_only_the_bound_samples_in_percent(genomes, syl2db, tmp_path, caplog):
    caplog.set_level("INFO", logger="qiita_compute_orchestrator.jobs.taxonomic_profile")
    reads = _reads(
        genomes,
        tmp_path,
        {101: {"G000": 0.8, "G001": 0.2}, 102: {"G002": 1.0}, 103: {"G000": 1.0}},
    )
    out = await execute(_inputs(tmp_path, reads, syl2db, [101, 102]), tmp_path / "ws")
    staged = out["staging_dir"] / "taxonomic_profile.parquet"
    with duckdb.connect() as con:
        rows = con.execute(
            "SELECT prep_sample_idx, processing_idx, genome_name, taxonomic_abundance,"
            " adjusted_ani FROM read_parquet(?) ORDER BY 1, 3",
            [str(staged)],
        ).fetchall()
        counts = con.execute(
            "SELECT * FROM read_parquet(?) ORDER BY 1", [str(out["profile_counts"])]
        ).fetchall()
    assert [(r[0], r[1], r[2]) for r in rows] == [
        (101, 77, "G000"),
        (101, 77, "G001"),
        (102, 77, "G002"),
    ]
    totals: dict[int, float] = {}
    for r in rows:
        totals[r[0]] = totals.get(r[0], 0.0) + r[3]
        assert 0 < r[4] <= 1
    assert totals == pytest.approx({101: 100.0, 102: 100.0})
    assert rows[0][3] == pytest.approx(80, abs=5)
    assert counts == [(101, 2), (102, 1)]
    assert "90000 reads over 3 samples; 2 of 2 requested samples streamed" in caplog.text
    assert "not profiled (not metagenomic): 103" in caplog.text


async def test_a_bound_sample_missing_from_the_stream_is_logged(genomes, syl2db, tmp_path, caplog):
    reads = _reads(genomes, tmp_path, {101: {"G000": 1.0}})
    out = await execute(_inputs(tmp_path, reads, syl2db, [101, 555]), tmp_path / "ws")
    with duckdb.connect() as con:
        counts = con.execute(
            "SELECT * FROM read_parquet(?)", [str(out["profile_counts"])]
        ).fetchall()
    assert counts == [(101, 1)]
    assert "requested samples with no streamed reads: 555" in caplog.text


async def test_a_stream_with_none_of_the_bound_samples_fails(genomes, syl2db, tmp_path):
    """Every bound sample has stored reads, so an empty result is a fault in the
    stream, not a no-data outcome."""
    reads = _reads(genomes, tmp_path, {101: {"G000": 1.0}})
    with pytest.raises(RuntimeError, match=r"no read for any of the 1 samples .*\(555\)"):
        await execute(_inputs(tmp_path, reads, syl2db, [555]), tmp_path / "ws")


def test_min_ani_is_a_fraction(tmp_path):
    with pytest.raises(ValidationError):
        _inputs(tmp_path, None, tmp_path / "db.syl2db", [1], min_ani=95)


async def test_refuses_an_empty_sample_list(syl2db, tmp_path):
    with pytest.raises(ValueError, match="non-empty"):
        await execute(_inputs(tmp_path, None, syl2db, []), tmp_path / "ws")
