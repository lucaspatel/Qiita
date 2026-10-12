"""Route tests for POST /reference/file: registering a sylph database on the
sequence reference it was sketched from."""

import hashlib

import pytest
from httpx import ASGITransport, AsyncClient
from qiita_common.api_paths import URL_REFERENCE_FILE, URL_REFERENCE_INDEX

from qiita_control_plane.testing.db_seeds import (
    cleanup_genome_reference,
    seed_bare_reference,
    seed_genome_reference,
)

pytestmark = pytest.mark.db


@pytest.fixture
async def admin(postgres_pool, human_admin_session):
    from qiita_control_plane.main import app

    app.state.pool = postgres_pool
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers={"Authorization": f"Bearer {human_admin_session['token']}"},
    ) as ac:
        yield ac


@pytest.fixture
async def reference(postgres_pool):
    seeded = await seed_genome_reference(postgres_pool, label="sylph-test", n_genomes=2)
    yield seeded
    await cleanup_genome_reference(postgres_pool, seeded)


@pytest.fixture
def syl2db(tmp_path):
    path = tmp_path / "wol3_rc4_ani95.syl2db"
    path.write_bytes(b"not really a sylph database")
    return path


def _body(path, reference_idx, **kw):
    data = path.read_bytes()
    return {
        "reference_idx": reference_idx,
        "fs_path": str(path),
        "sha256": hashlib.sha256(data).hexdigest(),
        "size_bytes": len(data),
        **kw,
    }


async def test_registers_a_sylph_index_on_the_reference(admin, reference, syl2db):
    ref = reference["reference_idx"]
    body = _body(syl2db, ref, label="ani95")
    resp = await admin.post(URL_REFERENCE_FILE, json=body)
    assert resp.status_code == 201, resp.text
    out = resp.json()
    assert out["reference"]["reference_idx"] == ref
    assert out["reference"]["kind"] == "sequence_reference"
    assert out["index"]["index_type"] == "sylph"
    assert out["index"]["fs_path"] == str(syl2db)
    assert out["index"]["params"] == {
        "format": "syl2db",
        "sha256": body["sha256"],
        "size_bytes": body["size_bytes"],
        "label": "ani95",
    }
    listed = await admin.get(URL_REFERENCE_INDEX.format(reference_idx=ref))
    assert [i["reference_index_idx"] for i in listed.json()] == [
        out["index"]["reference_index_idx"]
    ]


async def test_a_reference_may_carry_several(admin, reference, syl2db, tmp_path):
    ref = reference["reference_idx"]
    other = tmp_path / "wol3_rc4_ani99.syl2db"
    other.write_bytes(b"another sylph database")
    for path, label in ((syl2db, "ani95"), (other, "ani99")):
        resp = await admin.post(URL_REFERENCE_FILE, json=_body(path, ref, label=label))
        assert resp.status_code == 201, resp.text
    listed = await admin.get(URL_REFERENCE_INDEX.format(reference_idx=ref))
    assert sorted(i["params"]["label"] for i in listed.json()) == ["ani95", "ani99"]


async def test_refuses_a_reference_with_no_genomes(admin, postgres_pool, syl2db):
    ref = await seed_bare_reference(postgres_pool, label="sylph-test-bare")
    await postgres_pool.execute(
        "UPDATE qiita.reference SET status = 'active' WHERE reference_idx = $1", ref
    )
    try:
        resp = await admin.post(URL_REFERENCE_FILE, json=_body(syl2db, ref))
        assert resp.status_code == 409, resp.text
        assert "no genomes" in resp.json()["detail"]
    finally:
        await postgres_pool.execute("DELETE FROM qiita.reference WHERE reference_idx = $1", ref)


async def test_refuses_an_inactive_reference(admin, postgres_pool, syl2db):
    seeded = await seed_genome_reference(
        postgres_pool, label="sylph-test-pending", n_genomes=1, active=False
    )
    try:
        resp = await admin.post(URL_REFERENCE_FILE, json=_body(syl2db, seeded["reference_idx"]))
        assert resp.status_code == 409, resp.text
    finally:
        await cleanup_genome_reference(postgres_pool, seeded)


async def test_refuses_a_missing_reference(admin, syl2db):
    resp = await admin.post(URL_REFERENCE_FILE, json=_body(syl2db, 2**62))
    assert resp.status_code == 404, resp.text


async def test_refuses_a_missing_file(admin, reference, tmp_path):
    missing = tmp_path / "gone.syl2db"
    resp = await admin.post(
        URL_REFERENCE_FILE,
        json={
            "reference_idx": reference["reference_idx"],
            "fs_path": str(missing),
            "sha256": "0" * 64,
            "size_bytes": 1,
        },
    )
    assert resp.status_code == 422
    assert "cannot stat" in resp.json()["detail"]


async def test_refuses_a_size_that_does_not_match(admin, reference, syl2db):
    resp = await admin.post(
        URL_REFERENCE_FILE, json=_body(syl2db, reference["reference_idx"], size_bytes=1)
    )
    assert resp.status_code == 422
    assert "bytes" in resp.json()["detail"]


async def test_refuses_a_directory(admin, reference, tmp_path):
    d = tmp_path / "dir.syl2db"
    d.mkdir()
    resp = await admin.post(
        URL_REFERENCE_FILE,
        json={
            "reference_idx": reference["reference_idx"],
            "fs_path": str(d),
            "sha256": "0" * 64,
            "size_bytes": d.stat().st_size,
        },
    )
    assert resp.status_code == 422
    assert "not a regular file" in resp.json()["detail"]


@pytest.mark.parametrize(
    "override",
    [
        {"fs_path": "relative/wol3.syl2db"},
        {"fs_path": "/abs/wol3.fasta"},
        {"sha256": "XYZ"},
        {"index_type": "rype"},
        {"index_type": "sylph_taxonomy"},
        {"name": "wol3"},
        {"reference_idx": None},
        {"label": ""},
    ],
)
async def test_refuses_a_malformed_request(admin, reference, syl2db, override):
    resp = await admin.post(
        URL_REFERENCE_FILE, json={**_body(syl2db, reference["reference_idx"]), **override}
    )
    assert resp.status_code == 422, resp.text


async def test_needs_a_system_admin(role_keyed_clients, reference, syl2db):
    resp = await role_keyed_clients["wet"].post(
        URL_REFERENCE_FILE, json=_body(syl2db, reference["reference_idx"])
    )
    assert resp.status_code == 403, resp.text
