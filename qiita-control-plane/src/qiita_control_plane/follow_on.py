"""Submit a completed ticket's follow-on (`qiita.work_ticket.on_success`).

`submit_follow_on` runs from dispatch's completion hook after every terminal
outcome and is a no-op unless the ticket COMPLETED with an `on_success`. It
claims the submission with one conditional UPDATE, so a ticket's follow-on is
submitted at most once however many hooks race, then submits it through
`submit_work_ticket_core` as the originator, on the parent's scope target. The
outcome lands on the parent row: the created ticket's idx, or the refusal.

`reconcile_follow_ons` (lifespan startup, before tickets are re-driven) covers
the gaps a restart leaves: a ticket that completed while no hook ran, and a
claim whose submission never recorded an outcome. Re-submitting the latter is
safe: if the first attempt did create the ticket, the submit gate's dedupe
refuses the second with a 409 that names it, and that refusal is recorded.
"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Any

from fastapi import HTTPException
from qiita_common.models import WorkTicketCreateRequest, WorkTicketState

from .auth.principal import PrincipalUnusableError, load_human_user

if TYPE_CHECKING:
    import asyncpg
    from fastapi import FastAPI

_log = logging.getLogger(__name__)


async def _claim(pool: asyncpg.Pool, work_ticket_idx: int) -> bool:
    claimed = await pool.fetchval(
        "UPDATE qiita.work_ticket SET follow_on_claimed_at = now()"
        " WHERE work_ticket_idx = $1 AND state = $2::qiita.work_ticket_state"
        "   AND on_success IS NOT NULL AND follow_on_claimed_at IS NULL"
        " RETURNING work_ticket_idx",
        work_ticket_idx,
        WorkTicketState.COMPLETED.value,
    )
    return claimed is not None


async def _record(
    pool: asyncpg.Pool,
    work_ticket_idx: int,
    *,
    created_idx: int | None = None,
    error: str | None = None,
) -> None:
    await pool.execute(
        "UPDATE qiita.work_ticket"
        " SET follow_on_work_ticket_idx = $2, follow_on_error = $3"
        " WHERE work_ticket_idx = $1",
        work_ticket_idx,
        created_idx,
        error,
    )


def _describe_refusal(exc: HTTPException) -> str:
    detail: Any = exc.detail
    text = detail if isinstance(detail, str) else json.dumps(detail, sort_keys=True)
    return f"HTTP {exc.status_code}: {text}"


async def _submit_claimed(app: FastAPI, work_ticket_idx: int) -> None:
    """Submit the follow-on of a ticket this process has claimed, and record
    the outcome. Every failure is recorded; none propagates."""
    # Imported here: routes.work_ticket imports dispatch, which imports this module.
    from .routes.work_ticket import fetch_work_ticket, submit_work_ticket_core

    pool: asyncpg.Pool = app.state.pool
    parent = await fetch_work_ticket(pool, work_ticket_idx)
    if parent is None or parent.on_success is None:
        return
    try:
        principal = await load_human_user(pool, parent.originator_principal_idx)
        body = WorkTicketCreateRequest(
            action_id=parent.on_success.action_id,
            action_version=parent.on_success.action_version,
            scope_target=parent.scope_target,
            action_context=parent.on_success.action_context,
        )
        created = await submit_work_ticket_core(app=app, principal=principal, body=body)
    except PrincipalUnusableError as exc:
        await _record(pool, work_ticket_idx, error=f"originator cannot submit: {exc}")
        return
    except HTTPException as exc:
        await _record(pool, work_ticket_idx, error=_describe_refusal(exc))
        return
    except Exception as exc:
        _log.exception("follow-on of work_ticket %d failed to submit", work_ticket_idx)
        await _record(pool, work_ticket_idx, error=f"{type(exc).__name__}: {exc}")
        return
    await _record(pool, work_ticket_idx, created_idx=created.work_ticket_idx)
    _log.info(
        "work_ticket %d completed; submitted follow-on work_ticket %d",
        work_ticket_idx,
        created.work_ticket_idx,
    )


async def submit_follow_on(app: FastAPI, work_ticket_idx: int) -> None:
    """Submit `work_ticket_idx`'s follow-on if it just COMPLETED with one."""
    if await _claim(app.state.pool, work_ticket_idx):
        await _submit_claimed(app, work_ticket_idx)


async def reconcile_follow_ons(app: FastAPI) -> None:
    """Submit every completed ticket's follow-on that has no outcome yet.

    Runs once at startup, before any ticket is dispatched, so no live hook can
    hold a claim this resets."""
    pool: asyncpg.Pool = app.state.pool
    rows = await pool.fetch(
        "UPDATE qiita.work_ticket SET follow_on_claimed_at = now()"
        " WHERE state = $1::qiita.work_ticket_state AND on_success IS NOT NULL"
        "   AND follow_on_work_ticket_idx IS NULL AND follow_on_error IS NULL"
        " RETURNING work_ticket_idx",
        WorkTicketState.COMPLETED.value,
    )
    for row in rows:
        await _submit_claimed(app, row["work_ticket_idx"])
