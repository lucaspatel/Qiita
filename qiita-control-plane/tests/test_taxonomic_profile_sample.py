"""The taxonomic-profile completion gate, `qiita.taxonomic_profile_sample`, and the
runner pieces around it: the pool's metagenomic population, the sylph database
resolver, the identity knobs, and the closing action."""

import hashlib
import json
import uuid

import duckdb
import pytest
from qiita_common.backend_failure import BackendFailure

from qiita_control_plane.actions.library import finalize_taxonomic_profile_sample
from qiita_control_plane.repositories.processing import mint_processing
from qiita_control_plane.repositories.taxonomic_profile import (
    create_taxonomic_profile_samples_pending,
    list_pool_metagenomic_prep_sample_idxs,
)
from qiita_control_plane.runner._processing import (
    _build_processing_params,
    _record_taxonomic_profile_gate_no_data,
)
from qiita_control_plane.runner._reference import _resolve_sylph_database
from qiita_control_plane.runner._workflow import _resolve_profile_samples
from qiita_control_plane.testing.db_seeds import (
    cleanup_genome_reference,
    seed_biosample_with_sequenced_prep_sample,
    seed_genome_reference,
    seed_sequenced_sample_subtype,
    seed_user_principal,
)
from qiita_control_plane.testing.db_teardown import delete_principal, teardown_entity_graph

pytestmark = pytest.mark.db


@pytest.fixture
async def run(postgres_pool):
    """A pool of two metagenomic prep_samples with reads, one amplicon one (an ENA
    study's runs share a pool), and one metagenomic one whose download left no
    reads; and a taxonomic-profile processing run."""
    owner = await seed_user_principal(
        postgres_pool, prefix="prof-gate", suffix=str(uuid.uuid4())[:8]
    )
    samples, run_idx, pool_idx = [], None, None
    for i, protocol in enumerate(
        ("short_read_metagenomics", "long_read_metagenomics", "short_read_amplicon")
        + ("short_read_metagenomics",)
    ):
        bs, ps = await seed_biosample_with_sequenced_prep_sample(
            postgres_pool, owner_idx=owner, protocol_name=protocol
        )
        run_idx, pool_idx, _ = await seed_sequenced_sample_subtype(
            postgres_pool,
            prep_sample_idx=ps,
            owner_idx=owner,
            sequenced_pool_item_id=f"prof-gate-{i}",
            sequencing_run_idx=run_idx,
            sequenced_pool_idx=pool_idx,
        )
        samples.append((bs, ps))
    for _, ps in samples[:3]:
        await postgres_pool.execute(
            "INSERT INTO qiita.sequence_range"
            " (prep_sample_idx, sequence_idx_start, sequence_idx_stop, created_by_idx)"
            " VALUES ($1, 1, 10, $2)",
            ps,
            owner,
        )
    async with postgres_pool.acquire() as conn:
        processing = await mint_processing(
            conn,
            workflow="taxonomic-profile",
            version="1.0.0",
            params={"workflow": "taxonomic-profile", "probe": str(uuid.uuid4())},
        )
    p = processing["processing_idx"]
    yield {
        "processing_idx": p,
        "pool_idx": pool_idx,
        "owner": owner,
        "metagenomic": [samples[0][1], samples[1][1]],
        "amplicon": samples[2][1],
        "unread": samples[3][1],
    }
    await postgres_pool.execute(
        "DELETE FROM qiita.exported_identifier WHERE processing_idx = $1", p
    )
    await postgres_pool.execute(
        "DELETE FROM qiita.taxonomic_profile_sample WHERE processing_idx = $1", p
    )
    await postgres_pool.execute("DELETE FROM qiita.processing WHERE processing_idx = $1", p)
    await teardown_entity_graph(
        postgres_pool,
        study_idxs=[],
        biosample_idxs=[b for b, _ in samples],
        prep_sample_idxs=[ps for _, ps in samples],
    )
    await postgres_pool.execute("DELETE FROM qiita.sequenced_pool WHERE idx = $1", pool_idx)
    await postgres_pool.execute("DELETE FROM qiita.sequencing_run WHERE idx = $1", run_idx)
    await delete_principal(postgres_pool, [owner])


async def _states(pool, processing_idx):
    rows = await pool.fetch(
        "SELECT prep_sample_idx, state, genome_count FROM qiita.taxonomic_profile_sample"
        " WHERE processing_idx = $1 ORDER BY prep_sample_idx",
        processing_idx,
    )
    return {r["prep_sample_idx"]: (r["state"], r["genome_count"]) for r in rows}


async def _pending(pool, run):
    async with pool.acquire() as conn, conn.transaction():
        await create_taxonomic_profile_samples_pending(
            conn, processing_idx=run["processing_idx"], prep_sample_idxs=run["metagenomic"]
        )


async def test_the_pool_population_is_its_metagenomic_samples_with_reads(postgres_pool, run):
    assert await list_pool_metagenomic_prep_sample_idxs(postgres_pool, run["pool_idx"]) == sorted(
        run["metagenomic"]
    )


async def test_a_run_covers_the_pool_or_the_samples_chosen_from_it(postgres_pool, run):
    pool_idx, chosen = run["pool_idx"], run["metagenomic"][1]
    assert await _resolve_profile_samples(
        postgres_pool, sequenced_pool_idx=pool_idx, action_context={}
    ) == sorted(run["metagenomic"])
    assert await _resolve_profile_samples(
        postgres_pool, sequenced_pool_idx=pool_idx, action_context={"prep_sample_idxs": [chosen]}
    ) == [chosen]


@pytest.mark.parametrize("which", ["amplicon", "unread"])
async def test_a_chosen_sample_the_pool_cannot_profile_is_refused(postgres_pool, run, which):
    with pytest.raises(BackendFailure, match=str(run[which])):
        await _resolve_profile_samples(
            postgres_pool,
            sequenced_pool_idx=run["pool_idx"],
            action_context={"prep_sample_idxs": [run["metagenomic"][0], run[which]]},
        )


async def test_finalize_closes_the_gate_and_mints_identifiers(postgres_pool, run, tmp_path):
    await _pending(postgres_pool, run)
    a, b = run["metagenomic"]
    counts = tmp_path / "profile_counts.parquet"
    with duckdb.connect() as con:
        con.execute(
            f"COPY (SELECT {a}::BIGINT AS prep_sample_idx, 7::INTEGER AS genome_count)"
            f" TO '{counts}' (FORMAT PARQUET)"
        )
    written = await finalize_taxonomic_profile_sample(
        postgres_pool,
        processing_idx=run["processing_idx"],
        prep_sample_idxs=run["metagenomic"],
        profile_counts_path=counts,
        created_by_idx=run["owner"],
    )
    assert written == (1, 1)
    assert await _states(postgres_pool, run["processing_idx"]) == {
        a: ("completed", 7),
        b: ("no_data", None),
    }
    minted = await postgres_pool.fetch(
        "SELECT prep_sample_idx FROM qiita.exported_identifier"
        " WHERE processing_idx = $1 AND NOT retired",
        run["processing_idx"],
    )
    assert [r["prep_sample_idx"] for r in minted] == [a]


async def test_a_no_data_run_closes_every_pending_row(postgres_pool, run):
    await _pending(postgres_pool, run)
    await _record_taxonomic_profile_gate_no_data(
        postgres_pool, processing_idx=run["processing_idx"], prep_sample_idxs=run["metagenomic"]
    )
    states = await _states(postgres_pool, run["processing_idx"])
    assert set(states.values()) == {("no_data", None)}


async def test_closing_leaves_another_tickets_pending_rows_alone(postgres_pool, run, tmp_path):
    """Two pools profiled against one database share the processing_idx; one
    ticket's close, normal or no-data, must not touch the other's samples."""
    a, b = run["metagenomic"]
    other = run["unread"]
    async with postgres_pool.acquire() as conn, conn.transaction():
        await create_taxonomic_profile_samples_pending(
            conn, processing_idx=run["processing_idx"], prep_sample_idxs=[a, b, other]
        )
    await _record_taxonomic_profile_gate_no_data(
        postgres_pool, processing_idx=run["processing_idx"], prep_sample_idxs=[b]
    )
    counts = tmp_path / "profile_counts.parquet"
    with duckdb.connect() as con:
        con.execute(
            f"COPY (SELECT {a}::BIGINT AS prep_sample_idx, 3::INTEGER AS genome_count)"
            f" TO '{counts}' (FORMAT PARQUET)"
        )
    written = await finalize_taxonomic_profile_sample(
        postgres_pool,
        processing_idx=run["processing_idx"],
        prep_sample_idxs=[a],
        profile_counts_path=counts,
        created_by_idx=run["owner"],
    )
    assert written == (1, 0)
    assert await _states(postgres_pool, run["processing_idx"]) == {
        a: ("completed", 3),
        b: ("no_data", None),
        other: ("pending", None),
    }


def test_the_identity_carries_the_database_file_and_threshold():
    bound = {"sylph_reference_idx": 4, "sylph_database_sha256": "ab" * 32}
    base = _build_processing_params("taxonomic-profile", "1.0.0", bound)
    assert base == {
        "workflow": "taxonomic-profile",
        "version": "1.0.0",
        "sylph_reference_idx": 4,
        "sylph_database_sha256": "ab" * 32,
    }
    assert _build_processing_params("taxonomic-profile", "1.0.0", {**bound, "min_ani": 0.97}) == {
        **base,
        "min_ani": 0.97,
    }
    assert "trim" not in base and "sylph_reference_idx" not in _build_processing_params(
        "amplicon", "1.1.0", {"trim": 150, "sortmerna_reference_idx": 1}
    )


@pytest.fixture
async def sylph_reference(postgres_pool, tmp_path):
    """A sylph index row on a two-genome sequence reference."""
    seeded = await seed_genome_reference(postgres_pool, label="sylph-resolve", n_genomes=2)
    db = tmp_path / "wol3.syl2db"
    db.write_bytes(b"sylph")
    sha = hashlib.sha256(b"sylph").hexdigest()
    index_idx = await postgres_pool.fetchval(
        "INSERT INTO qiita.reference_index (reference_idx, index_type, fs_path, params)"
        " VALUES ($1, 'sylph', $2, $3::jsonb) RETURNING reference_index_idx",
        seeded["reference_idx"],
        str(db),
        json.dumps({"format": "syl2db", "sha256": sha, "size_bytes": 5}),
    )
    yield {**seeded, "index_idx": index_idx, "path": db, "sha256": sha}
    await cleanup_genome_reference(postgres_pool, seeded)


async def test_the_resolver_binds_the_file_its_reference_and_genome_map(
    postgres_pool, sylph_reference, tmp_path
):
    bound = await _resolve_sylph_database(
        postgres_pool,
        action_context={"sylph_index_idx": sylph_reference["index_idx"]},
        workspace=tmp_path,
    )
    genome_map = bound.pop("genome_map")
    assert bound == {
        "sylph_database": sylph_reference["path"],
        "sylph_database_sha256": sylph_reference["sha256"],
        "sylph_reference_idx": sylph_reference["reference_idx"],
    }
    with duckdb.connect() as con:
        rows = con.execute(
            "SELECT genome_idx, source_id FROM read_parquet(?) ORDER BY 1", [str(genome_map)]
        ).fetchall()
    assert rows == sorted(sylph_reference["genomes"])


async def test_the_resolver_refuses_a_moved_file(postgres_pool, sylph_reference, tmp_path):
    sylph_reference["path"].unlink()
    with pytest.raises(Exception, match="no longer a file"):
        await _resolve_sylph_database(
            postgres_pool,
            action_context={"sylph_index_idx": sylph_reference["index_idx"]},
            workspace=tmp_path,
        )


async def test_the_resolver_refuses_another_index_and_an_inactive_reference(
    postgres_pool, sylph_reference, tmp_path
):
    with pytest.raises(Exception, match="is not a sylph index"):
        await _resolve_sylph_database(
            postgres_pool, action_context={"sylph_index_idx": 2**62}, workspace=tmp_path
        )
    await postgres_pool.execute(
        "UPDATE qiita.reference SET status = 'failed' WHERE reference_idx = $1",
        sylph_reference["reference_idx"],
    )
    with pytest.raises(Exception, match="not an active sequence_reference"):
        await _resolve_sylph_database(
            postgres_pool,
            action_context={"sylph_index_idx": sylph_reference["index_idx"]},
            workspace=tmp_path,
        )
