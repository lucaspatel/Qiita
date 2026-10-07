"""Named CLI environments: which control plane a command talks to, and with
which token.

A user who works against more than one deployment (production, a dev stack)
names each one in `~/.qiita/config.toml`:

    current = "prod"

    [env.prod]
    base_url = "https://qiita-miint.ucsd.edu"

    [env.dev]
    base_url = "http://localhost:18080"

Each environment's PAT lives in its own file, `~/.qiita/tokens/<name>`. The
invariant this module exists to keep: **a stored token is only ever sent to
the environment it was stored for.** Before environments, one `~/.qiita/token`
was paired with whatever `$QIITA_CONTROL_PLANE_URL` happened to say, so
pointing the CLI at a dev stack quietly sent it the production PAT.

Target resolution, first match wins (`resolve_target` enforces it):

1. `--env NAME` or `--base-url URL` on the command line (mutually exclusive).
2. `$QIITA_ENV` or `$QIITA_CONTROL_PLANE_URL` (an error if both are set and
   name different URLs).
3. The config's `current`.
4. `DEFAULT_CONTROL_PLANE_URL`.

A target given as a URL that matches a configured environment's `base_url`
adopts that environment, token included. `$QIITA_TOKEN` pairs only with a
target given as a URL — the caller supplied both halves, as the shared dev
stack's `stack.env` does. With a target chosen by environment name it is
refused rather than ignored, because it is exactly the stray-token case above.
With no config file at all, nothing changes: the URL comes from the flags /
env var / default and the token from `$QIITA_TOKEN` or `~/.qiita/token`.

`$QIITA_CONFIG` overrides the config path; the token directory sits beside it.
"""

from __future__ import annotations

import json
import os
import re
import tomllib
from dataclasses import dataclass
from pathlib import Path

QIITA_CONFIG_ENV = "QIITA_CONFIG"
QIITA_ENV_ENV = "QIITA_ENV"
CONFIG_FILE_DEFAULT = Path.home() / ".qiita" / "config.toml"
TOKEN_DIR_NAME = "tokens"

# Doubles as the token's filename, so it must be a safe path component.
_ENV_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")


class EnvConfigError(RuntimeError):
    """A config / selection problem, reported as `error: <message>`."""


@dataclass(frozen=True, slots=True)
class Environment:
    name: str
    base_url: str
    token_file: Path


@dataclass(frozen=True, slots=True)
class EnvConfig:
    path: Path
    current: str | None
    envs: dict[str, Environment]

    def get(self, name: str) -> Environment:
        try:
            return self.envs[name]
        except KeyError:
            known = ", ".join(sorted(self.envs)) or "none"
            raise EnvConfigError(
                f"no environment named {name!r} in {self.path} (configured: {known})"
            ) from None

    def by_url(self, base_url: str) -> Environment | None:
        wanted = normalize_url(base_url)
        for env in self.envs.values():
            if normalize_url(env.base_url) == wanted:
                return env
        return None


@dataclass(frozen=True, slots=True)
class Target:
    """The resolved destination of one CLI invocation.

    `env` is None only when the target is a URL that no configured
    environment claims. `by_url` records whether the caller named the target
    as a URL (and so may pair it with `$QIITA_TOKEN`). `config_present`
    decides whether the pre-environment `~/.qiita/token` fallback still
    applies to an unclaimed URL.
    """

    base_url: str
    env: Environment | None
    by_url: bool
    config_present: bool


def config_path() -> Path:
    return Path(os.environ.get(QIITA_CONFIG_ENV) or CONFIG_FILE_DEFAULT)


def normalize_url(url: str) -> str:
    return url.rstrip("/")


def validate_env_name(name: str) -> str:
    if not _ENV_NAME_RE.match(name):
        raise EnvConfigError(
            f"environment name must be a lowercase slug of 1-32 [a-z0-9-] characters"
            f" starting with [a-z0-9], got {name!r}"
        )
    return name


def _token_file(path: Path, name: str) -> Path:
    return path.parent / TOKEN_DIR_NAME / name


def load_config(path: Path | None = None) -> EnvConfig | None:
    """Parse the config, or None when the file does not exist. A file that
    exists but is malformed raises — a half-read config must not silently
    fall back to the no-config behaviour."""
    path = path or config_path()
    if not path.is_file():
        return None
    try:
        raw = tomllib.loads(path.read_text())
    except tomllib.TOMLDecodeError as exc:
        raise EnvConfigError(f"{path} is not valid TOML: {exc}") from exc
    unknown = set(raw) - {"current", "env"}
    if unknown:
        raise EnvConfigError(f"{path}: unknown top-level keys {sorted(unknown)}")
    envs: dict[str, Environment] = {}
    for name, table in (raw.get("env") or {}).items():
        validate_env_name(name)
        if not isinstance(table, dict) or set(table) != {"base_url"}:
            raise EnvConfigError(f"{path}: [env.{name}] must hold exactly `base_url`")
        if not isinstance(table["base_url"], str) or not table["base_url"]:
            raise EnvConfigError(f"{path}: [env.{name}].base_url must be a non-empty string")
        envs[name] = Environment(name, table["base_url"], _token_file(path, name))
    # A `current` naming no table is kept, not rejected here: resolution
    # refuses it (via `get`), while `qiita env use` can still repair it.
    current = raw.get("current")
    if current is not None and not isinstance(current, str):
        raise EnvConfigError(f"{path}: current must be a string")
    return EnvConfig(path=path, current=current, envs=envs)


def save_config(config: EnvConfig) -> None:
    """Write the config back. Values are plain strings, which a JSON string
    literal encodes as a valid TOML basic string."""
    lines: list[str] = []
    if config.current is not None:
        lines += [f"current = {json.dumps(config.current)}", ""]
    for name in sorted(config.envs):
        lines += [f"[env.{name}]", f"base_url = {json.dumps(config.envs[name].base_url)}", ""]
    config.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = config.path.with_suffix(config.path.suffix + ".tmp")
    tmp.write_text("\n".join(lines))
    tmp.replace(config.path)


def new_environment(config: EnvConfig, name: str, base_url: str) -> Environment:
    return Environment(validate_env_name(name), base_url, _token_file(config.path, name))


def resolve_target(
    *,
    flag_env: str | None,
    flag_base_url: str | None,
    default_url: str,
    url_env_var: str,
) -> Target:
    """Apply the precedence in the module docstring."""
    if flag_env and flag_base_url:
        raise EnvConfigError("pass --env or --base-url, not both")
    config = load_config()
    present = config is not None

    def _by_name(name: str) -> Target:
        if config is None:
            raise EnvConfigError(
                f"environment {name!r} requested but {config_path()} does not exist"
                " (create one with `qiita env add`)"
            )
        env = config.get(name)
        return Target(env.base_url, env, by_url=False, config_present=True)

    def _by_url(url: str) -> Target:
        env = config.by_url(url) if config else None
        return Target(url, env, by_url=True, config_present=present)

    if flag_env:
        return _by_name(flag_env)
    if flag_base_url:
        return _by_url(flag_base_url)

    env_name = os.environ.get(QIITA_ENV_ENV) or None
    env_url = os.environ.get(url_env_var) or None
    if env_name and env_url:
        named = _by_name(env_name)
        if normalize_url(named.base_url) != normalize_url(env_url):
            raise EnvConfigError(
                f"${QIITA_ENV_ENV}={env_name!r} ({named.base_url}) disagrees with"
                f" ${url_env_var}={env_url!r}; unset one"
            )
        return named
    if env_name:
        return _by_name(env_name)
    if env_url:
        return _by_url(env_url)
    if config is not None and config.current is not None:
        return _by_name(config.current)
    return _by_url(default_url)
