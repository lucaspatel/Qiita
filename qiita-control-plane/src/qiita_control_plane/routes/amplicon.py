"""An amplicon run's feature table over REST.

`GET /amplicon/{processing_idx}/feature-table` serves the table a completed
amplicon run produced, as TSV: ASV sequences by the samples' QM identifiers. A
REST route rather than a ticket mint because its consumers include the web UI,
which cannot speak Flight, and because the table is small (a pool's ASVs).

The cohort is the run's samples that hold a live QM identifier — the workflow
mints one per processed sample at load (`mint-amplicon-identifiers`), so a run
with none is a run with nothing to serve. `study_idx` narrows the cohort to the
samples linked to one study, which is how a reader of one study in a multi-study
pool gets its share; it narrows by an explicit request, never silently.

Access is `authorize_prep_sample_cohort`, all-or-nothing over the cohort, at the
tier the other cohort reads use. The data plane serves exactly the cohort the
ticket carries, so that gate is the authorization boundary.
"""

import asyncio
from typing import Annotated

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import PlainTextResponse
from pydantic import Field
from qiita_common.api_paths import PATH_AMPLICON_FEATURE_TABLE, PATH_AMPLICON_PREFIX
from qiita_common.auth_constants import Scope

from ..amplicon_feature_table import fetch_amplicon_run, render_feature_table_tsv
from ..auth.guards import COHORT_MIN_TIER, require_complete_profile, require_scope
from ..auth.principal import HumanUser, Principal
from ..deps import get_data_plane_url, get_db_pool, get_flight_signing_key
from ._helpers import authorize_prep_sample_cohort

router = APIRouter(prefix=PATH_AMPLICON_PREFIX, tags=["amplicon"])

AMPLICON_WORKFLOW = "amplicon"
TSV_MEDIA_TYPE = "text/tab-separated-values"


async def _run_labels(
    pool: asyncpg.Pool, processing_idx: int, study_idx: int | None
) -> dict[int, str]:
    """prep_sample_idx -> export_id for the run's live identifiers, ascending,
    optionally only those linked (unretired) to `study_idx`."""
    rows = await pool.fetch(
        "SELECT ei.prep_sample_idx, ei.export_id"
        "  FROM qiita.exported_identifier ei"
        " WHERE ei.processing_idx = $1 AND NOT ei.retired"
        "   AND ($2::bigint IS NULL OR EXISTS ("
        "     SELECT 1 FROM qiita.prep_sample_to_study pst"
        "      WHERE pst.prep_sample_idx = ei.prep_sample_idx"
        "        AND pst.study_idx = $2 AND NOT pst.retired))"
        " ORDER BY ei.prep_sample_idx",
        processing_idx,
        study_idx,
    )
    return {row["prep_sample_idx"]: row["export_id"] for row in rows}


@router.get(PATH_AMPLICON_FEATURE_TABLE, response_class=PlainTextResponse)
async def get_amplicon_feature_table(
    processing_idx: Annotated[int, Field(gt=0)],
    study_idx: Annotated[int | None, Query(gt=0)] = None,
    pool: asyncpg.Pool = Depends(get_db_pool),
    signing_key: bytes = Depends(get_flight_signing_key),
    data_plane_url: str = Depends(get_data_plane_url),
    caller: HumanUser = Depends(require_complete_profile),
    _scope: Principal = Depends(require_scope(Scope.PREP_SAMPLE_READ)),
) -> PlainTextResponse:
    """The run's feature table as TSV (`#OTU ID`, then one column per sample)."""
    workflow = await pool.fetchval(
        "SELECT workflow FROM qiita.processing WHERE processing_idx = $1", processing_idx
    )
    if workflow != AMPLICON_WORKFLOW:
        raise HTTPException(status_code=404, detail="amplicon run not found")

    labels = await _run_labels(pool, processing_idx, study_idx)
    if not labels:
        detail = (
            "the amplicon run has no processed samples"
            if study_idx is None
            else "the amplicon run has no processed samples in that study"
        )
        raise HTTPException(status_code=404, detail=detail)

    cohort = await authorize_prep_sample_cohort(
        pool, caller=caller, prep_sample_idx=labels, min_tier=COHORT_MIN_TIER
    )
    membership, chunks = await asyncio.to_thread(
        lambda: fetch_amplicon_run(
            data_plane_url=data_plane_url,
            signing_key=signing_key,
            processing_idx=processing_idx,
            prep_sample_idxs=cohort,
        )
    )
    tsv = render_feature_table_tsv(membership, chunks, labels)
    return PlainTextResponse(
        tsv,
        media_type=TSV_MEDIA_TYPE,
        headers={"Content-Disposition": 'attachment; filename="amplicon-feature-table.tsv"'},
    )
