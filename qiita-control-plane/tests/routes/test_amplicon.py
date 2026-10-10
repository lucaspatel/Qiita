"""Route tests for GET /amplicon/{processing_idx}/feature-table.

The run's cohort is the samples it minted QM identifiers for at load. Access is
all-or-nothing over that cohort (or over the slice a `study_idx` names), in the
order the other cohort routes use: the run exists → access → content. The
data-plane read is stubbed; its scope is pinned by the data plane's own tests.
"""

import uuid

import pyarrow as pa
import pytest
from qiita_common.api_paths import URL_AMPLICON_FEATURE_TABLE

from qiita_control_plane.repositories.processing import mint_processing

pytestmark = pytest.mark.db


@pytest.fixture
async def amplicon_run(role_keyed_clients, pool_alignment_seed, monkeypatch):
    """An amplicon run over ps_a + ps_c (study_1) and ps_b (study_2), its QM
    identifiers minted, and the data-plane fetch stubbed to that cohort's ASVs."""
    seed, db = pool_alignment_seed, role_keyed_clients["pool"]
    async with db.acquire() as conn:
        run = await mint_processing(
            conn,
            workflow="amplicon",
            version="1.1.0",
            params={"workflow": "amplicon", "version": "1.1.0", "probe": str(uuid.uuid4())},
        )
    processing_idx = run["processing_idx"]
    cohort = sorted([seed["ps_a"], seed["ps_b"], seed["ps_c"]])
    await db.execute(
        "INSERT INTO qiita.exported_identifier (processing_idx, prep_sample_idx, created_by_idx)"
        " SELECT $1, unnest($2::bigint[]), $3",
        processing_idx,
        cohort,
        seed["owner_idx"],
    )
    fetched: list[list[int]] = []

    def _fetch(*, data_plane_url, signing_key, processing_idx, prep_sample_idxs):
        fetched.append(list(prep_sample_idxs))
        membership = pa.table(
            {
                "prep_sample_idx": pa.array(prep_sample_idxs, pa.int64()),
                "processing_idx": pa.array([processing_idx] * len(prep_sample_idxs), pa.int64()),
                "feature_idx": pa.array([77] * len(prep_sample_idxs), pa.int64()),
                "count": pa.array(range(1, len(prep_sample_idxs) + 1), pa.int64()),
            }
        )
        chunks = pa.table(
            {
                "feature_idx": pa.array([77], pa.int64()),
                "chunk_index": pa.array([0], pa.int32()),
                "chunk_data": pa.array(["ACGTACGT"], pa.string()),
            }
        )
        return membership, chunks

    monkeypatch.setattr("qiita_control_plane.routes.amplicon.fetch_amplicon_run", _fetch)
    yield {"processing_idx": processing_idx, "fetched": fetched, **seed}
    await db.execute(
        "DELETE FROM qiita.exported_identifier WHERE processing_idx = $1", processing_idx
    )
    await db.execute("DELETE FROM qiita.processing WHERE processing_idx = $1", processing_idx)


async def _export_ids(db, processing_idx, prep_sample_idxs):
    rows = await db.fetch(
        "SELECT prep_sample_idx, export_id FROM qiita.exported_identifier"
        " WHERE processing_idx = $1 ORDER BY prep_sample_idx",
        processing_idx,
    )
    return [r["export_id"] for r in rows if r["prep_sample_idx"] in prep_sample_idxs]


async def test_serves_the_whole_run_as_tsv(role_keyed_clients, amplicon_run):
    run, db = amplicon_run, role_keyed_clients["pool"]
    resp = await role_keyed_clients["wet"].get(
        URL_AMPLICON_FEATURE_TABLE.format(processing_idx=run["processing_idx"])
    )
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/tab-separated-values")
    cohort = sorted([run["ps_a"], run["ps_b"], run["ps_c"]])
    labels = await _export_ids(db, run["processing_idx"], cohort)
    assert resp.text.splitlines() == ["#OTU ID\t" + "\t".join(labels), "ACGTACGT\t1\t2\t3"]
    assert run["fetched"] == [cohort]


async def test_404s_an_unknown_run(role_keyed_clients, amplicon_run):
    resp = await role_keyed_clients["wet"].get(
        URL_AMPLICON_FEATURE_TABLE.format(processing_idx=2**62)
    )
    assert resp.status_code == 404, resp.text


async def test_404s_a_run_that_is_not_amplicon(role_keyed_clients, amplicon_run):
    db = role_keyed_clients["pool"]
    async with db.acquire() as conn:
        other = await mint_processing(
            conn,
            workflow="long-read-assembly",
            version="1.0.0",
            params={"workflow": "long-read-assembly", "probe": str(uuid.uuid4())},
        )
    try:
        resp = await role_keyed_clients["wet"].get(
            URL_AMPLICON_FEATURE_TABLE.format(processing_idx=other["processing_idx"])
        )
        assert resp.status_code == 404, resp.text
    finally:
        await db.execute(
            "DELETE FROM qiita.processing WHERE processing_idx = $1", other["processing_idx"]
        )


async def test_refuses_a_partially_readable_run_whole(role_keyed_clients, amplicon_run):
    """The reader sees study_1 only; ps_b is study_2's. Nothing is fetched."""
    run = amplicon_run
    resp = await role_keyed_clients["user"].get(
        URL_AMPLICON_FEATURE_TABLE.format(processing_idx=run["processing_idx"])
    )
    assert resp.status_code == 403, resp.text
    assert run["fetched"] == []


async def test_study_idx_narrows_to_that_studys_samples(role_keyed_clients, amplicon_run):
    run, db = amplicon_run, role_keyed_clients["pool"]
    resp = await role_keyed_clients["user"].get(
        URL_AMPLICON_FEATURE_TABLE.format(processing_idx=run["processing_idx"]),
        params={"study_idx": run["study_1"]},
    )
    assert resp.status_code == 200, resp.text
    cohort = sorted([run["ps_a"], run["ps_c"]])
    labels = await _export_ids(db, run["processing_idx"], cohort)
    assert resp.text.splitlines()[0] == "#OTU ID\t" + "\t".join(labels)
    assert run["fetched"] == [cohort]


async def test_study_idx_with_none_of_the_run_404s(role_keyed_clients, amplicon_run):
    run = amplicon_run
    resp = await role_keyed_clients["wet"].get(
        URL_AMPLICON_FEATURE_TABLE.format(processing_idx=run["processing_idx"]),
        params={"study_idx": 2**62},
    )
    assert resp.status_code == 404, resp.text


async def test_requires_auth(role_keyed_clients, amplicon_run):
    from httpx import ASGITransport, AsyncClient

    from qiita_control_plane.main import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as anon:
        resp = await anon.get(
            URL_AMPLICON_FEATURE_TABLE.format(processing_idx=amplicon_run["processing_idx"])
        )
    assert resp.status_code == 401, resp.text
