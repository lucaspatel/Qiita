"""Create the local stack's two principals and write a fresh token for each.

Local only: production principals come from OIDC login and the admin
service-account route; a laptop stack has no identity provider, so this writes
them straight into the stack's own database. `scripts/local-stack.sh` runs it on
every `up`; it is idempotent on the principals and mints new tokens each time.

  * `local-admin` — a system_admin human with a complete profile; its token is
    what the CLI and the web UI use (`QIITA_TOKEN`).
  * `local-compute` — the orchestrator's service account (CO→CP callbacks), with
    the scopes the compute-service-account runbook grants.

Usage: python local_stack_bootstrap.py <admin-token-path> <compute-token-path>
(DATABASE_URL from the environment). Refuses any database whose name does not
start with `qiita_local`, so it cannot be pointed at a shared one by accident.
"""

import asyncio
import os
import sys
from pathlib import Path
from urllib.parse import urlparse

import asyncpg
from qiita_common.auth_constants import SYSTEM_PRINCIPAL_IDX, Scope, SystemRole

from qiita_control_plane.auth.scopes import role_ceiling
from qiita_control_plane.auth.token import mint_api_token

ADMIN_EMAIL = "local-admin@localhost.localdomain"
COMPUTE_NAME = "local-compute"
COMPUTE_SCOPES = [Scope.SEQUENCE_RANGE_MINT, Scope.TICKET_DOGET]
LOCAL_DB_PREFIX = "qiita_local"


async def _ensure_admin(conn: asyncpg.Connection) -> int:
    idx = await conn.fetchval(
        "SELECT principal_idx FROM qiita.user WHERE email = $1", ADMIN_EMAIL
    )
    if idx is not None:
        return idx
    idx = await conn.fetchval(
        "INSERT INTO qiita.principal (display_name, system_role, created_by_idx)"
        " VALUES ('local-admin', $1, $2) RETURNING idx",
        SystemRole.SYSTEM_ADMIN,
        SYSTEM_PRINCIPAL_IDX,
    )
    await conn.execute(
        "INSERT INTO qiita.user (principal_idx, email, affiliation, address, phone)"
        " VALUES ($1, $2, 'local', 'local', '000')",
        idx,
        ADMIN_EMAIL,
    )
    return idx


async def _ensure_compute(conn: asyncpg.Connection) -> int:
    idx = await conn.fetchval(
        "SELECT principal_idx FROM qiita.service_account WHERE name = $1", COMPUTE_NAME
    )
    if idx is not None:
        return idx
    idx = await conn.fetchval(
        "INSERT INTO qiita.principal (display_name, system_role, created_by_idx)"
        " VALUES ($1, $2, $3) RETURNING idx",
        COMPUTE_NAME,
        SystemRole.USER,
        SYSTEM_PRINCIPAL_IDX,
    )
    await conn.execute(
        "INSERT INTO qiita.service_account (principal_idx, name) VALUES ($1, $2)",
        idx,
        COMPUTE_NAME,
    )
    return idx


def _write_secret(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".new")
    tmp.write_text(value + "\n")
    tmp.chmod(0o600)
    tmp.replace(path)


async def main(admin_token_path: Path, compute_token_path: Path) -> None:
    url = os.environ["DATABASE_URL"]
    db = urlparse(url).path.lstrip("/")
    if not db.startswith(LOCAL_DB_PREFIX):
        raise SystemExit(f"refusing database {db!r}: not a {LOCAL_DB_PREFIX}* database")
    conn = await asyncpg.connect(url)
    try:
        async with conn.transaction():
            admin_idx = await _ensure_admin(conn)
            compute_idx = await _ensure_compute(conn)
            admin_token, _ = await mint_api_token(
                conn,
                principal_idx=admin_idx,
                label="local-stack",
                scopes=sorted(role_ceiling(SystemRole.SYSTEM_ADMIN)),
            )
            compute_token, _ = await mint_api_token(
                conn,
                principal_idx=compute_idx,
                label="local-stack",
                scopes=COMPUTE_SCOPES,
            )
    finally:
        await conn.close()
    _write_secret(admin_token_path, admin_token)
    _write_secret(compute_token_path, compute_token)
    print(f"local-admin principal {admin_idx}, local-compute principal {compute_idx}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    asyncio.run(main(Path(sys.argv[1]), Path(sys.argv[2])))
