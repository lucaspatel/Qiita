"""`qiita reference register-file`: hashes the file locally and POSTs it."""

import hashlib

import httpx
from qiita_common.api_paths import URL_REFERENCE_FILE


def test_register_file_hashes_the_file_and_posts_it(monkeypatch, tmp_path):
    from qiita_control_plane.cli import _common
    from qiita_control_plane.cli.user._parser import _build_parser

    db = tmp_path / "wol3_rc4_ani95.syl2db"
    db.write_bytes(b"sylph bytes")
    captured: dict = {}

    def fake_request(method, url, headers=None, json=None, params=None, timeout=None):
        captured.update(method=method, url=url, json=json)
        return httpx.Response(201, json={}, request=httpx.Request(method, url))

    monkeypatch.setattr(_common.httpx, "request", fake_request)
    monkeypatch.setattr(_common, "run_http_subcommand", lambda fn, render=None: fn("tok") and 0)

    parser = _build_parser()
    args = parser.parse_args(
        [
            "--base-url",
            "http://cp",
            "reference",
            "register-file",
            "--name",
            "wol3",
            "--version",
            "rc4-ani95",
            "--path",
            str(db),
        ]
    )
    args.handler(args, parser)
    assert captured["method"] == "POST"
    assert captured["url"] == f"http://cp{URL_REFERENCE_FILE}"
    assert captured["json"] == {
        "name": "wol3",
        "version": "rc4-ani95",
        "index_type": "sylph",
        "fs_path": str(db.resolve()),
        "sha256": hashlib.sha256(b"sylph bytes").hexdigest(),
        "size_bytes": len(b"sylph bytes"),
    }


def test_register_file_attaches_a_taxonomy_to_an_existing_release(monkeypatch, tmp_path):
    from qiita_control_plane.cli import _common
    from qiita_control_plane.cli.user._parser import _build_parser

    tsv = tmp_path / "wol3_taxonomy.tsv"
    tsv.write_text("G1.fna.gz\td__Bacteria\n")
    captured: dict = {}

    def fake_request(method, url, headers=None, json=None, params=None, timeout=None):
        captured.update(json=json)
        return httpx.Response(201, json={}, request=httpx.Request(method, url))

    monkeypatch.setattr(_common.httpx, "request", fake_request)
    monkeypatch.setattr(_common, "run_http_subcommand", lambda fn, render=None: fn("tok") and 0)
    parser = _build_parser()
    args = parser.parse_args(
        [
            "--base-url",
            "http://cp",
            "reference",
            "register-file",
            "--reference-idx",
            "9",
            "--index-type",
            "sylph_taxonomy",
            "--path",
            str(tsv),
        ]
    )
    args.handler(args, parser)
    assert captured["json"]["reference_idx"] == 9
    assert captured["json"]["index_type"] == "sylph_taxonomy"
    assert "name" not in captured["json"]
