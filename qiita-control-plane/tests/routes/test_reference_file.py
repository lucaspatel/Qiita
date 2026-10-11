"""Route tests for POST /reference/file: registering a profiling database file."""

import hashlib
import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from qiita_common.api_paths import URL_REFERENCE_FILE, URL_REFERENCE_INDEX

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
    await postgres_pool.execute(
        "DELETE FROM qiita.profiling_taxonomy WHERE reference_idx IN"
        " (SELECT reference_idx FROM qiita.reference WHERE name LIKE 'sylph-test-%')"
    )
    await postgres_pool.execute(
        "DELETE FROM qiita.reference_index WHERE reference_idx IN"
        " (SELECT reference_idx FROM qiita.reference WHERE name LIKE 'sylph-test-%')"
    )
    await postgres_pool.execute("DELETE FROM qiita.reference WHERE name LIKE 'sylph-test-%'")


@pytest.fixture
def syl2db(tmp_path):
    path = tmp_path / "wol3_rc4_ani95.syl2db"
    path.write_bytes(b"not really a sylph database")
    return path


def _body(path, **kw):
    data = path.read_bytes()
    return {
        "name": f"sylph-test-{uuid.uuid4().hex[:8]}",
        "version": "rc4-ani95",
        "fs_path": str(path),
        "sha256": hashlib.sha256(data).hexdigest(),
        "size_bytes": len(data),
        **kw,
    }


async def test_registers_an_active_profiling_database_and_its_index(admin, syl2db):
    body = _body(syl2db)
    resp = await admin.post(URL_REFERENCE_FILE, json=body)
    assert resp.status_code == 201, resp.text
    out = resp.json()
    assert out["reference"]["kind"] == "profiling_database"
    assert out["reference"]["status"] == "active"
    assert out["index"]["index_type"] == "sylph"
    assert out["index"]["fs_path"] == str(syl2db)
    assert out["index"]["params"] == {
        "format": "syl2db",
        "sha256": body["sha256"],
        "size_bytes": body["size_bytes"],
    }
    listed = await admin.get(
        URL_REFERENCE_INDEX.format(reference_idx=out["reference"]["reference_idx"])
    )
    assert [i["reference_index_idx"] for i in listed.json()] == [
        out["index"]["reference_index_idx"]
    ]


async def test_refuses_a_duplicate_name_and_version(admin, syl2db):
    body = _body(syl2db)
    assert (await admin.post(URL_REFERENCE_FILE, json=body)).status_code == 201
    resp = await admin.post(URL_REFERENCE_FILE, json=body)
    assert resp.status_code == 409, resp.text


async def test_refuses_a_missing_file(admin, tmp_path):
    missing = tmp_path / "gone.syl2db"
    resp = await admin.post(
        URL_REFERENCE_FILE,
        json={
            "name": "sylph-test-missing",
            "version": "1",
            "fs_path": str(missing),
            "sha256": "0" * 64,
            "size_bytes": 1,
        },
    )
    assert resp.status_code == 422
    assert "cannot stat" in resp.json()["detail"]


async def test_refuses_a_size_that_does_not_match(admin, syl2db):
    resp = await admin.post(URL_REFERENCE_FILE, json=_body(syl2db, size_bytes=1))
    assert resp.status_code == 422
    assert "bytes" in resp.json()["detail"]


async def test_refuses_a_directory(admin, tmp_path):
    d = tmp_path / "dir.syl2db"
    d.mkdir()
    resp = await admin.post(
        URL_REFERENCE_FILE,
        json={
            "name": "sylph-test-dir",
            "version": "1",
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
        {"kind": "sequence_reference"},
        {"index_type": "sylph_taxonomy"},
        {"reference_idx": 1},
    ],
)
async def test_refuses_a_malformed_request(admin, syl2db, override):
    resp = await admin.post(URL_REFERENCE_FILE, json=_body(syl2db, **override))
    assert resp.status_code == 422, resp.text


async def test_needs_a_system_admin(role_keyed_clients, syl2db):
    resp = await role_keyed_clients["wet"].post(URL_REFERENCE_FILE, json=_body(syl2db))
    assert resp.status_code == 403, resp.text


async def test_attaches_a_taxonomy_file_to_the_release_and_loads_it(admin, syl2db, tmp_path):
    created = (await admin.post(URL_REFERENCE_FILE, json=_body(syl2db))).json()
    ref = created["reference"]["reference_idx"]
    tsv = tmp_path / "wol3_rc4_ani95_taxonomy.tsv"
    tsv.write_text(
        "G000802255.fna.gz\td__Bacteria;s__Burkholderia contaminans\n"
        "G024244725.fna.gz\td__Bacteria;p__Desulfobacterota_102087;g__;s__\n"
    )
    body = {k: v for k, v in _body(tsv).items() if k not in ("name", "version")}
    resp = await admin.post(
        URL_REFERENCE_FILE, json={**body, "reference_idx": ref, "index_type": "sylph_taxonomy"}
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["index"]["params"]["genome_count"] == 2
    listed = await admin.get(URL_REFERENCE_INDEX.format(reference_idx=ref))
    assert sorted(i["index_type"] for i in listed.json()) == ["sylph", "sylph_taxonomy"]


async def test_refuses_a_malformed_taxonomy_line(admin, syl2db, tmp_path):
    ref = (await admin.post(URL_REFERENCE_FILE, json=_body(syl2db))).json()["reference"][
        "reference_idx"
    ]
    tsv = tmp_path / "bad.tsv"
    tsv.write_text("G1.fna.gz\td__Bacteria\nno-tab-here\n")
    body = {k: v for k, v in _body(tsv).items() if k not in ("name", "version")}
    resp = await admin.post(
        URL_REFERENCE_FILE, json={**body, "reference_idx": ref, "index_type": "sylph_taxonomy"}
    )
    assert resp.status_code == 422
    assert ":2:" in resp.json()["detail"]


async def test_refuses_attaching_to_a_missing_release(admin, tmp_path):
    tsv = tmp_path / "t.tsv"
    tsv.write_text("G1.fna.gz\td__Bacteria\n")
    body = {k: v for k, v in _body(tsv).items() if k not in ("name", "version")}
    resp = await admin.post(
        URL_REFERENCE_FILE,
        json={**body, "reference_idx": 2**62, "index_type": "sylph_taxonomy"},
    )
    assert resp.status_code == 404, resp.text
