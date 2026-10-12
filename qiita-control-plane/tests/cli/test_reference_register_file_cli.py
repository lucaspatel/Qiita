"""`qiita reference register-file`: hashes the file locally and POSTs it."""

import hashlib

import httpx
from qiita_common.api_paths import URL_REFERENCE_FILE


def _run(monkeypatch, argv):
    from qiita_control_plane.cli import _common
    from qiita_control_plane.cli.user._parser import _build_parser

    captured: dict = {}

    def fake_request(method, url, headers=None, json=None, params=None, timeout=None):
        captured.update(method=method, url=url, json=json)
        return httpx.Response(201, json={}, request=httpx.Request(method, url))

    monkeypatch.setattr(_common.httpx, "request", fake_request)
    monkeypatch.setattr(_common, "run_http_subcommand", lambda fn, render=None: fn("tok") and 0)
    parser = _build_parser()
    args = parser.parse_args(["--base-url", "http://cp", "reference", "register-file", *argv])
    args.handler(args, parser)
    return captured


def test_register_file_hashes_the_file_and_posts_it(monkeypatch, tmp_path):
    db = tmp_path / "wol3_rc4_ani95.syl2db"
    db.write_bytes(b"sylph bytes")
    captured = _run(monkeypatch, ["--reference-idx", "18", "--path", str(db), "--label", "ani95"])
    assert captured["method"] == "POST"
    assert captured["url"] == f"http://cp{URL_REFERENCE_FILE}"
    assert captured["json"] == {
        "reference_idx": 18,
        "index_type": "sylph",
        "fs_path": str(db.resolve()),
        "sha256": hashlib.sha256(b"sylph bytes").hexdigest(),
        "size_bytes": len(b"sylph bytes"),
        "label": "ani95",
    }


def test_the_label_is_optional(monkeypatch, tmp_path):
    db = tmp_path / "wol3.syl2db"
    db.write_bytes(b"sylph bytes")
    captured = _run(monkeypatch, ["--reference-idx", "18", "--path", str(db)])
    assert "label" not in captured["json"]
