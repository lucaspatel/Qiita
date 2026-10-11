"""qiita env — manage named environments (see `cli._environment`).

These subcommands edit the config rather than talk to a control plane, so
they set `needs_target=False` and skip target resolution: they must work on
exactly the config that resolution would reject.
"""

import argparse
import dataclasses
import sys
from pathlib import Path

from .. import _common, _environment


def _load_or_empty() -> _environment.EnvConfig:
    path = _environment.config_path()
    return _environment.load_config(path) or _environment.EnvConfig(path, None, {})


def _guard(fn):
    """Report a config problem as `error: ...` / exit 1, like the HTTP
    subcommands report theirs."""

    def wrapped(args: argparse.Namespace, parser: argparse.ArgumentParser) -> int:
        try:
            return fn(args, parser)
        except _environment.EnvConfigError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1

    return wrapped


@_guard
def _handle_env_list(args: argparse.Namespace, parser: argparse.ArgumentParser) -> int:
    config = _environment.load_config()
    if config is None or not config.envs:
        print(f"no environments configured ({_environment.config_path()})")
        return 0
    for name in sorted(config.envs):
        env = config.envs[name]
        marker = "*" if name == config.current else " "
        token = "token" if env.token_file.is_file() else "no token"
        print(f"{marker} {name:<16} {env.base_url}  ({token})")
    return 0


@_guard
def _handle_env_add(args: argparse.Namespace, parser: argparse.ArgumentParser) -> int:
    config = _load_or_empty()
    name = _environment.validate_env_name(args.name)
    if name in config.envs:
        # A token is bound to the URL it was minted on; re-pointing an existing
        # name would hand that token to a different server.
        raise _environment.EnvConfigError(
            f"environment {name!r} already exists ({config.envs[name].base_url});"
            f" `qiita env remove {name}` first to change its URL"
        )
    claimed = config.by_url(args.base_url)
    if claimed is not None:
        raise _environment.EnvConfigError(
            f"{args.base_url} is already environment {claimed.name!r}"
        )
    env = _environment.new_environment(config, name, args.base_url)
    if env.token_file.exists():
        raise _environment.EnvConfigError(
            f"{env.token_file} already exists but belongs to no environment; remove it"
            " first rather than adopt a token of unknown origin"
        )
    if args.adopt_token is not None:
        if not args.adopt_token.is_file():
            raise _environment.EnvConfigError(f"--adopt-token: {args.adopt_token} is not a file")
        _common.write_token(env.token_file, args.adopt_token.read_text().strip())
    current = name if (args.use or config.current is None) else config.current
    _environment.save_config(
        dataclasses.replace(config, current=current, envs={**config.envs, name: env})
    )
    print(f"added {name} → {env.base_url}" + (" (current)" if current == name else ""))
    if not env.token_file.is_file():
        print(f"log in with: qiita --env {name} login")
    return 0


@_guard
def _handle_env_use(args: argparse.Namespace, parser: argparse.ArgumentParser) -> int:
    config = _environment.load_config()
    if config is None:
        raise _environment.EnvConfigError(
            f"{_environment.config_path()} does not exist; `qiita env add` first"
        )
    env = config.get(args.name)
    _environment.save_config(dataclasses.replace(config, current=env.name))
    print(f"current environment: {env.name} → {env.base_url}")
    return 0


@_guard
def _handle_env_remove(args: argparse.Namespace, parser: argparse.ArgumentParser) -> int:
    config = _environment.load_config()
    if config is None:
        raise _environment.EnvConfigError(f"{_environment.config_path()} does not exist")
    env = config.get(args.name)
    envs = {k: v for k, v in config.envs.items() if k != env.name}
    current = None if config.current == env.name else config.current
    _environment.save_config(dataclasses.replace(config, current=current, envs=envs))
    # The token goes with its environment, so a later environment of the same
    # name (possibly another URL) can never inherit it.
    env.token_file.unlink(missing_ok=True)
    print(f"removed {env.name} and its token")
    if current is None and envs:
        print("no current environment; pick one with `qiita env use NAME`")
    return 0


def add_env_parser(sub: argparse._SubParsersAction) -> None:
    p_env = sub.add_parser("env", help="Manage named environments (prod, dev, ...)")
    p_env.set_defaults(needs_target=False)
    env_sub = p_env.add_subparsers(dest="env_cmd", required=True)

    p_list = env_sub.add_parser("list", help="List environments; * marks the current one")
    p_list.set_defaults(handler=_handle_env_list, needs_target=False)

    p_add = env_sub.add_parser("add", help="Add an environment (the first one becomes current)")
    p_add.add_argument("name")
    p_add.add_argument("base_url")
    p_add.add_argument("--use", action="store_true", help="Also make it the current environment")
    p_add.add_argument(
        "--adopt-token",
        type=Path,
        default=None,
        help=(
            "Copy an existing PAT file (e.g. ~/.qiita/token) in as this environment's"
            " token — only if it was minted on this environment's server"
        ),
    )
    p_add.set_defaults(handler=_handle_env_add, needs_target=False)

    p_use = env_sub.add_parser("use", help="Make an environment the current one")
    p_use.add_argument("name")
    p_use.set_defaults(handler=_handle_env_use, needs_target=False)

    p_remove = env_sub.add_parser("remove", help="Remove an environment and delete its token")
    p_remove.add_argument("name")
    p_remove.set_defaults(handler=_handle_env_remove, needs_target=False)
