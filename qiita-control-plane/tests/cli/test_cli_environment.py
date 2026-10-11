"""Named CLI environments: `qiita env ...` and target / token resolution.

The isolation fixture in tests/cli/conftest.py points $QIITA_CONFIG at an
empty per-test path, so every test here starts with no config file.
"""

import os
from pathlib import Path

import pytest

from qiita_control_plane.cli import _common, _environment
from qiita_control_plane.cli.user import main
from qiita_control_plane.cli.user._parser import _build_parser

PROD = "https://qiita.example.org"
DEV = "http://localhost:18080"


@pytest.fixture(autouse=True)
def _clean_env_vars(monkeypatch, tmp_path):
    monkeypatch.delenv(_common.QIITA_TOKEN_ENV, raising=False)
    monkeypatch.delenv(_common.QIITA_CONTROL_PLANE_URL_ENV, raising=False)
    # The legacy single-token path, so no test reads the real ~/.qiita/token.
    monkeypatch.setattr(_common, "TOKEN_FILE_DEFAULT", tmp_path / "legacy-token")


def _config_dir() -> Path:
    return _environment.config_path().parent


def _token(name: str) -> Path:
    return _config_dir() / _environment.TOKEN_DIR_NAME / name


def _resolve(*argv: str):
    """Parse `argv` + `whoami`, resolve the target, return the namespace."""
    parser = _build_parser()
    args = parser.parse_args([*argv, "whoami"])
    _common.validate_base_url(args, parser)
    return args


def _add_prod_and_dev() -> None:
    assert main(["env", "add", "prod", PROD]) == 0
    assert main(["env", "add", "dev", DEV]) == 0
    _common.write_token(_token("prod"), "prod-pat\n")
    _common.write_token(_token("dev"), "dev-pat\n")


# --- qiita env ------------------------------------------------------------


def test_first_env_added_becomes_current(capsys):
    _add_prod_and_dev()
    config = _environment.load_config()
    assert config.current == "prod"
    assert set(config.envs) == {"prod", "dev"}
    capsys.readouterr()
    assert main(["env", "list"]) == 0
    out = capsys.readouterr().out
    assert "* prod" in out and "  dev" in out


def test_use_switches_current():
    _add_prod_and_dev()
    assert main(["env", "use", "dev"]) == 0
    assert _environment.load_config().current == "dev"


def test_readding_a_name_is_refused_so_a_token_never_changes_server(capsys):
    _add_prod_and_dev()
    assert main(["env", "add", "prod", "https://elsewhere.example.org"]) == 1
    assert "already exists" in capsys.readouterr().err
    assert _environment.load_config().envs["prod"].base_url == PROD


def test_same_url_under_two_names_is_refused(capsys):
    _add_prod_and_dev()
    assert main(["env", "add", "prod2", PROD + "/"]) == 1
    assert "already environment 'prod'" in capsys.readouterr().err


def test_remove_deletes_the_token_and_clears_current():
    _add_prod_and_dev()
    assert main(["env", "remove", "prod"]) == 0
    assert not _token("prod").exists()
    config = _environment.load_config()
    assert config.current is None and set(config.envs) == {"dev"}


def test_add_refuses_an_orphan_token_file(capsys):
    _token("dev").parent.mkdir(parents=True)
    _token("dev").write_text("who-knows")
    assert main(["env", "add", "dev", DEV]) == 1
    assert "belongs to no environment" in capsys.readouterr().err


def test_adopt_token_copies_with_private_mode(tmp_path):
    legacy = tmp_path / "old-token"
    legacy.write_text("legacy-pat\n")
    assert main(["env", "add", "prod", PROD, "--adopt-token", str(legacy)]) == 0
    assert _token("prod").read_text() == "legacy-pat"
    assert os.stat(_token("prod")).st_mode & 0o777 == 0o600


def test_env_use_repairs_a_dangling_current():
    """`current` naming a missing env breaks resolution; `qiita env` skips
    resolution, so `env use` can still repair it."""
    _environment.config_path().parent.mkdir(parents=True, exist_ok=True)
    _environment.config_path().write_text(f'current = "gone"\n[env.dev]\nbase_url = "{DEV}"\n')
    with pytest.raises(SystemExit):
        _resolve()
    assert main(["env", "use", "dev"]) == 0
    assert _resolve().base_url == DEV


@pytest.mark.parametrize(
    "body",
    [
        "not toml = = =",
        'surprise = "x"\n',
        '[env.Prod]\nbase_url = "x"\n',
        '[env.dev]\nbase_url = "x"\ntoken = "inline"\n',
    ],
)
def test_malformed_config_fails_loudly(body):
    _environment.config_path().parent.mkdir(parents=True, exist_ok=True)
    _environment.config_path().write_text(body)
    with pytest.raises(SystemExit):
        _resolve()


# --- resolution -----------------------------------------------------------


def test_no_config_keeps_pre_environment_behaviour(monkeypatch):
    monkeypatch.setenv(_common.QIITA_CONTROL_PLANE_URL_ENV, DEV)
    _common.TOKEN_FILE_DEFAULT.write_text("legacy-pat")
    args = _resolve()
    assert args.base_url == DEV
    assert _common.read_token() == "legacy-pat"


def test_current_env_supplies_url_and_its_own_token():
    _add_prod_and_dev()
    args = _resolve()
    assert args.base_url == PROD
    assert _common.read_token() == "prod-pat"


def test_env_flag_beats_current_and_url_env_var(monkeypatch):
    _add_prod_and_dev()
    monkeypatch.setenv(_common.QIITA_CONTROL_PLANE_URL_ENV, PROD)
    args = _resolve("--env", "dev")
    assert args.base_url == DEV
    assert _common.read_token() == "dev-pat"


def test_qiita_env_var_selects_env(monkeypatch):
    _add_prod_and_dev()
    monkeypatch.setenv(_environment.QIITA_ENV_ENV, "dev")
    assert _resolve().base_url == DEV


def test_env_and_base_url_flags_are_exclusive():
    _add_prod_and_dev()
    with pytest.raises(SystemExit):
        _resolve("--env", "dev", "--base-url", DEV)


def test_disagreeing_env_vars_are_an_error(monkeypatch):
    _add_prod_and_dev()
    monkeypatch.setenv(_environment.QIITA_ENV_ENV, "prod")
    monkeypatch.setenv(_common.QIITA_CONTROL_PLANE_URL_ENV, DEV)
    with pytest.raises(SystemExit):
        _resolve()


def test_unknown_env_name_is_an_error():
    _add_prod_and_dev()
    with pytest.raises(SystemExit):
        _resolve("--env", "staging")


def test_url_matching_an_env_adopts_its_token(monkeypatch):
    _add_prod_and_dev()
    monkeypatch.setenv(_common.QIITA_CONTROL_PLANE_URL_ENV, DEV + "/")
    _resolve()
    assert _common.read_token() == "dev-pat"


def test_unclaimed_url_never_falls_back_to_a_stored_token():
    """The leak this feature exists to close: with a config present, a URL no
    environment claims gets no stored token — not the legacy one either."""
    _add_prod_and_dev()
    _common.TOKEN_FILE_DEFAULT.write_text("legacy-pat")
    _resolve("--base-url", "http://localhost:9999")
    with pytest.raises(RuntimeError, match="not a configured environment"):
        _common.read_token()


def test_qiita_token_pairs_with_a_url_target(monkeypatch):
    _add_prod_and_dev()
    monkeypatch.setenv(_common.QIITA_TOKEN_ENV, "explicit-pat")
    _resolve("--base-url", "http://localhost:9999")
    assert _common.read_token() == "explicit-pat"


def test_qiita_token_beside_a_named_env_is_refused(monkeypatch):
    _add_prod_and_dev()
    monkeypatch.setenv(_common.QIITA_TOKEN_ENV, "stray-prod-pat")
    _resolve("--env", "dev")
    with pytest.raises(RuntimeError, match="uses its own token"):
        _common.read_token()


def test_missing_env_token_names_the_login_command():
    assert main(["env", "add", "dev", DEV]) == 0
    _resolve()
    with pytest.raises(RuntimeError, match="qiita --env dev login"):
        _common.read_token()


# --- login's token file -----------------------------------------------------


def _login_args(*argv: str):
    parser = _build_parser()
    args = parser.parse_args([*argv, "login"])
    _common.validate_base_url(args, parser)
    return args


def test_login_writes_to_the_env_token_file():
    _add_prod_and_dev()
    assert _login_args("--env", "dev").token_file == _token("dev")


def test_login_without_config_uses_the_legacy_file():
    assert _login_args().token_file == _common.TOKEN_FILE_DEFAULT


def test_login_to_an_unclaimed_url_with_a_config_is_refused():
    _add_prod_and_dev()
    with pytest.raises(SystemExit):
        _login_args("--base-url", "http://localhost:9999")
