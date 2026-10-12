"""Route tests for GET /study/{study_idx}/lineage."""

import secrets
import uuid

import pytest
from qiita_common.actions import DOWNLOAD_ENA_STUDY_ACTION_ID
from qiita_common.api_paths import URL_STUDY_LINEAGE

from qiita_control_plane.ena_import.submit import DOWNLOAD_ENA_STUDY_ACTION_VERSION
from qiita_control_plane.repositories.processing import mint_processing
from qiita_control_plane.testing.db_seeds import (
    delete_action_if_created,
    seed_action_if_absent,
    seed_biosample_to_study_link,
    seed_biosample_with_sequenced_prep_sample,
    seed_prep_sample_to_study_link,
    seed_sequenced_sample_subtype,
    seed_study,
)
from qiita_control_plane.testing.db_teardown import teardown_entity_graph

pytestmark = pytest.mark.db


@pytest.fixture
async def amplicon_study(role_keyed_clients):
    """A study with three amplicon samples on one pool; an amplicon run that
    completed two (one with reads landed) and closed the third at no_data."""
    db = role_keyed_clients["pool"]
    owner = role_keyed_clients["wet_session"]["principal_idx"]
    study = await seed_study(db, owner_idx=owner, title=f"lineage-{secrets.token_hex(4)}")
    run_idx = pool_idx = None
    samples = []
    for i in range(3):
        bs, ps = await seed_biosample_with_sequenced_prep_sample(
            db, owner_idx=owner, protocol_name="short_read_amplicon"
        )
        run_idx, pool_idx, _ = await seed_sequenced_sample_subtype(
            db,
            prep_sample_idx=ps,
            owner_idx=owner,
            sequenced_pool_item_id=f"lin-{i}",
            sequencing_run_idx=run_idx,
            sequenced_pool_idx=pool_idx,
        )
        await seed_biosample_to_study_link(
            db, biosample_idx=bs, study_idx=study, created_by_idx=owner
        )
        await seed_prep_sample_to_study_link(
            db, prep_sample_idx=ps, study_idx=study, created_by_idx=owner
        )
        samples.append((bs, ps))
    ps_a, ps_b, ps_c = (ps for _, ps in samples)
    await db.execute(
        "INSERT INTO qiita.sequence_range"
        " (prep_sample_idx, sequence_idx_start, sequence_idx_stop, created_by_idx)"
        " VALUES ($1, 1, 10, $2)",
        ps_a,
        owner,
    )
    async with db.acquire() as conn:
        run = await mint_processing(
            conn,
            workflow="amplicon",
            version="1.1.0",
            params={"workflow": "amplicon", "version": "1.1.0", "probe": str(uuid.uuid4())},
        )
    p = run["processing_idx"]
    await db.execute(
        "INSERT INTO qiita.amplicon_sample (processing_idx, prep_sample_idx, state, asv_count)"
        " VALUES ($1, $2, 'completed', 12), ($1, $3, 'completed', 7), ($1, $4, 'no_data', NULL)",
        p,
        ps_a,
        ps_b,
        ps_c,
    )
    yield {"study_idx": study, "processing_idx": p, "ps": (ps_a, ps_b, ps_c), "pool_idx": pool_idx}
    await db.execute("DELETE FROM qiita.amplicon_sample WHERE processing_idx = $1", p)
    await db.execute("DELETE FROM qiita.processing WHERE processing_idx = $1", p)
    await teardown_entity_graph(
        db,
        study_idxs=[study],
        biosample_idxs=[bs for bs, _ in samples],
        prep_sample_idxs=[ps for _, ps in samples],
    )
    await db.execute("DELETE FROM qiita.sequenced_pool WHERE idx = $1", pool_idx)
    await db.execute("DELETE FROM qiita.sequencing_run WHERE idx = $1", run_idx)


async def test_lineage_groups_the_amplicon_dag(role_keyed_clients, amplicon_study):
    s = amplicon_study
    resp = await role_keyed_clients["wet"].get(URL_STUDY_LINEAGE.format(study_idx=s["study_idx"]))
    assert resp.status_code == 200, resp.text
    (group,) = resp.json()["groups"]
    assert group["prep_protocol"] == "short_read_amplicon"
    nodes = {n["id"]: n for n in group["nodes"]}
    p = s["processing_idx"]
    assert set(nodes) == {"run", "reads", f"processing:{p}", f"feature_table:{p}"}
    assert nodes[f"processing:{p}"]["counts"] == {"completed": 2, "no_data": 1}
    assert nodes[f"feature_table:{p}"]["counts"] == {"completed": 2}
    assert nodes["reads"]["counts"] == {"completed": 1, "not_started": 2}
    cells = {smp["prep_sample_idx"]: smp["cells"] for smp in group["samples"]}
    assert cells[s["ps"][0]][f"processing:{p}"] == {"state": "completed", "value": 12}
    assert cells[s["ps"][0]]["reads"] == {"state": "completed", "value": 10}


@pytest.fixture
async def ena_download_ticket(role_keyed_clients, amplicon_study):
    """A download-ena-study ticket still processing the study's pool."""
    db = role_keyed_clients["pool"]
    created = await seed_action_if_absent(
        db,
        action_id=DOWNLOAD_ENA_STUDY_ACTION_ID,
        version=DOWNLOAD_ENA_STUDY_ACTION_VERSION,
        target_kind="sequenced_pool",
    )
    ticket = await db.fetchval(
        "INSERT INTO qiita.work_ticket"
        " (action_id, action_version, originator_principal_idx, scope_target_kind,"
        "  sequenced_pool_idx, state)"
        " VALUES ($1, $2, $3, 'sequenced_pool', $4, 'processing')"
        " RETURNING work_ticket_idx",
        DOWNLOAD_ENA_STUDY_ACTION_ID,
        DOWNLOAD_ENA_STUDY_ACTION_VERSION,
        role_keyed_clients["wet_session"]["principal_idx"],
        amplicon_study["pool_idx"],
    )
    yield
    await db.execute("DELETE FROM qiita.work_ticket WHERE work_ticket_idx = $1", ticket)
    await delete_action_if_created(
        db,
        action_id=DOWNLOAD_ENA_STUDY_ACTION_ID,
        version=DOWNLOAD_ENA_STUDY_ACTION_VERSION,
        created=created,
    )


async def test_lineage_reads_follow_an_ena_download_in_progress(
    role_keyed_clients, amplicon_study, ena_download_ticket
):
    resp = await role_keyed_clients["wet"].get(
        URL_STUDY_LINEAGE.format(study_idx=amplicon_study["study_idx"])
    )
    assert resp.status_code == 200, resp.text
    (group,) = resp.json()["groups"]
    reads = next(n for n in group["nodes"] if n["id"] == "reads")
    assert reads["detail"] == "download-ena-study"
    assert reads["counts"] == {"completed": 1, "processing": 2}


@pytest.fixture
async def profile_run(role_keyed_clients, amplicon_study):
    """A taxonomic-profile run over the study's first two samples, against a sylph
    database labelled `ani95` on a sequence reference."""
    db = role_keyed_clients["pool"]
    ref = await db.fetchval(
        "INSERT INTO qiita.reference (name, version, kind, status, created_by_idx)"
        " VALUES ($1, 'rc4', 'sequence_reference', 'active', 1) RETURNING reference_idx",
        f"wol3-{secrets.token_hex(4)}",
    )
    await db.execute(
        "INSERT INTO qiita.reference_index (reference_idx, index_type, fs_path, params)"
        " VALUES ($1, 'sylph', '/srv/wol3.syl2db', $2::jsonb)",
        ref,
        '{"format": "syl2db", "sha256": "' + "ab" * 32 + '", "size_bytes": 1, "label": "ani95"}',
    )
    async with db.acquire() as conn:
        run = await mint_processing(
            conn,
            workflow="taxonomic-profile",
            version="1.0.0",
            params={
                "workflow": "taxonomic-profile",
                "version": "1.0.0",
                "sylph_reference_idx": ref,
                "sylph_database_sha256": "ab" * 32,
                "probe": str(uuid.uuid4()),
            },
        )
    p = run["processing_idx"]
    ps_a, ps_b, _ = amplicon_study["ps"]
    await db.execute(
        "INSERT INTO qiita.taxonomic_profile_sample"
        " (processing_idx, prep_sample_idx, state, genome_count)"
        " VALUES ($1, $2, 'completed', 40), ($1, $3, 'no_data', NULL)",
        p,
        ps_a,
        ps_b,
    )
    yield {"processing_idx": p, "reference_idx": ref}
    await db.execute("DELETE FROM qiita.taxonomic_profile_sample WHERE processing_idx = $1", p)
    await db.execute("DELETE FROM qiita.processing WHERE processing_idx = $1", p)
    await db.execute("DELETE FROM qiita.reference_index WHERE reference_idx = $1", ref)
    await db.execute("DELETE FROM qiita.reference WHERE reference_idx = $1", ref)


async def test_lineage_branches_a_taxonomic_profile_to_its_feature_table(
    role_keyed_clients, amplicon_study, profile_run
):
    resp = await role_keyed_clients["wet"].get(
        URL_STUDY_LINEAGE.format(study_idx=amplicon_study["study_idx"])
    )
    assert resp.status_code == 200, resp.text
    (group,) = resp.json()["groups"]
    nodes = {n["id"]: n for n in group["nodes"]}
    p = profile_run["processing_idx"]
    profile = nodes[f"processing:{p}"]
    assert profile["label"] == "Taxonomic profile"
    assert profile["detail"].startswith("taxonomic-profile 1.0.0 · wol3-")
    assert profile["detail"].endswith(" rc4 ani95")
    assert profile["counts"] == {"completed": 1, "no_data": 1, "not_started": 1}
    assert nodes[f"feature_table:{p}"]["counts"] == {"completed": 1}
    edges = {(e["source"], e["target"]) for e in group["edges"]}
    assert ("reads", f"processing:{p}") in edges
    assert (f"processing:{p}", f"feature_table:{p}") in edges


async def test_lineage_needs_study_access(role_keyed_clients, amplicon_study):
    resp = await role_keyed_clients["user"].get(
        URL_STUDY_LINEAGE.format(study_idx=amplicon_study["study_idx"])
    )
    assert resp.status_code == 403, resp.text


async def test_lineage_404s_an_unknown_study(role_keyed_clients):
    resp = await role_keyed_clients["wet"].get(URL_STUDY_LINEAGE.format(study_idx=2**62))
    assert resp.status_code == 404, resp.text
