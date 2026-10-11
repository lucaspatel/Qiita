"""Route tests for GET /study/{study_idx}/lineage."""

import secrets
import uuid

import pytest
from qiita_common.api_paths import URL_STUDY_LINEAGE

from qiita_control_plane.repositories.processing import mint_processing
from qiita_control_plane.testing.db_seeds import (
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
    yield {"study_idx": study, "processing_idx": p, "ps": (ps_a, ps_b, ps_c)}
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


async def test_lineage_needs_study_access(role_keyed_clients, amplicon_study):
    resp = await role_keyed_clients["user"].get(
        URL_STUDY_LINEAGE.format(study_idx=amplicon_study["study_idx"])
    )
    assert resp.status_code == 403, resp.text


async def test_lineage_404s_an_unknown_study(role_keyed_clients):
    resp = await role_keyed_clients["wet"].get(URL_STUDY_LINEAGE.format(study_idx=2**62))
    assert resp.status_code == 404, resp.text
