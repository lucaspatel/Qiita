"""The amplicon feature table over REST: one cohort request, three answers.

`POST /amplicon/feature-table/{samples,counts,features,ticket}` all take the same
body (`AmpliconFeatureTableRequest`: runs, and a study or a sample list) and answer:

  * samples — the table's columns as JSON: each processed sample's column name,
    its QM, its biosample's public name (to join to metadata), and its run;
  * counts — sparse COO `(sample, feature, count)` as an Arrow IPC stream;
  * features — `(feature, sequence, length)` for every feature the counts name,
    as an Arrow IPC stream;
  * ticket — the same reads as signed Flight tickets, with the columns, for a
    client that builds the table itself (the CLI).

What a feature table is, and why COO, is in `amplicon_feature_table`. REST
carries it beside Flight because the web UI cannot speak Flight; Arrow IPC keeps
the same columnar rows a Flight reader gets.

Access is `authorize_prep_sample_cohort`, all-or-nothing over the cohort, at the
tier the other cohort reads use, checked before anything is read from the data
plane. The data plane serves exactly the cohort the ticket carries, so that gate
is the authorization boundary.
"""

import asyncio
import base64

import asyncpg
import pyarrow as pa
import pyarrow.flight as flight
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from qiita_common.api_paths import (
    PATH_AMPLICON_FEATURE_TABLE_COUNTS,
    PATH_AMPLICON_FEATURE_TABLE_FEATURES,
    PATH_AMPLICON_FEATURE_TABLE_SAMPLES,
    PATH_AMPLICON_FEATURE_TABLE_TICKET,
    PATH_AMPLICON_PREFIX,
)
from qiita_common.auth_constants import Scope
from qiita_common.models.amplicon import (
    AmpliconFeatureTableRequest,
    AmpliconFeatureTableSamples,
    AmpliconFeatureTableTicketResponse,
    AmpliconFeatureTableTicketSample,
)

from ..amplicon_feature_table import (
    ARROW_STREAM_MEDIA_TYPE,
    Cohort,
    CohortError,
    arrow_stream_bytes,
    build_counts,
    build_features,
    cohort_tickets,
    fetch_amplicon_runs,
    resolve_cohort,
)
from ..auth.guards import COHORT_MIN_TIER, require_complete_profile, require_scope
from ..auth.principal import HumanUser, Principal
from ..deps import get_data_plane_url, get_db_pool, get_flight_signing_key
from ._helpers import authorize_prep_sample_cohort

router = APIRouter(prefix=PATH_AMPLICON_PREFIX, tags=["amplicon"])


async def _authorized_cohort(
    pool: asyncpg.Pool, caller: HumanUser, request: AmpliconFeatureTableRequest
) -> Cohort:
    try:
        cohort = await resolve_cohort(pool, request)
    except CohortError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    await authorize_prep_sample_cohort(
        pool, caller=caller, prep_sample_idx=cohort.prep_sample_idxs, min_tier=COHORT_MIN_TIER
    )
    return cohort


async def _read(
    cohort: Cohort, data_plane_url: str, signing_key: bytes, *, membership: bool
) -> tuple[pa.Table | None, pa.Table]:
    try:
        return await asyncio.to_thread(
            lambda: fetch_amplicon_runs(
                data_plane_url=data_plane_url,
                signing_key=signing_key,
                cohort=cohort,
                membership=membership,
            )
        )
    except flight.FlightError as exc:
        raise HTTPException(
            status_code=502, detail=f"data plane read of the amplicon runs failed: {exc}"
        ) from exc


@router.post(PATH_AMPLICON_FEATURE_TABLE_SAMPLES)
async def amplicon_feature_table_samples(
    request: AmpliconFeatureTableRequest,
    pool: asyncpg.Pool = Depends(get_db_pool),
    caller: HumanUser = Depends(require_complete_profile),
    _scope: Principal = Depends(require_scope(Scope.PREP_SAMPLE_READ)),
) -> AmpliconFeatureTableSamples:
    """The table's columns: one per processed sample the request names."""
    cohort = await _authorized_cohort(pool, caller, request)
    return AmpliconFeatureTableSamples(samples=[s.column for s in cohort.samples])


@router.post(PATH_AMPLICON_FEATURE_TABLE_COUNTS, response_class=Response)
async def amplicon_feature_table_counts(
    request: AmpliconFeatureTableRequest,
    pool: asyncpg.Pool = Depends(get_db_pool),
    signing_key: bytes = Depends(get_flight_signing_key),
    data_plane_url: str = Depends(get_data_plane_url),
    caller: HumanUser = Depends(require_complete_profile),
    _scope: Principal = Depends(require_scope(Scope.PREP_SAMPLE_READ)),
) -> Response:
    """The counts as sparse COO `(sample, feature, count)`, an Arrow IPC stream."""
    cohort = await _authorized_cohort(pool, caller, request)
    membership, chunks = await _read(cohort, data_plane_url, signing_key, membership=True)
    counts = build_counts(cohort, membership, chunks)
    return Response(arrow_stream_bytes(counts), media_type=ARROW_STREAM_MEDIA_TYPE)


@router.post(PATH_AMPLICON_FEATURE_TABLE_FEATURES, response_class=Response)
async def amplicon_feature_table_features(
    request: AmpliconFeatureTableRequest,
    pool: asyncpg.Pool = Depends(get_db_pool),
    signing_key: bytes = Depends(get_flight_signing_key),
    data_plane_url: str = Depends(get_data_plane_url),
    caller: HumanUser = Depends(require_complete_profile),
    _scope: Principal = Depends(require_scope(Scope.PREP_SAMPLE_READ)),
) -> Response:
    """Every feature the counts name, `(feature, sequence, length)`, an Arrow IPC
    stream. Reads only the ASV chunks: the ticket already scopes them to the ASVs
    the cohort observed."""
    cohort = await _authorized_cohort(pool, caller, request)
    _, chunks = await _read(cohort, data_plane_url, signing_key, membership=False)
    return Response(arrow_stream_bytes(build_features(chunks)), media_type=ARROW_STREAM_MEDIA_TYPE)


@router.post(PATH_AMPLICON_FEATURE_TABLE_TICKET)
async def amplicon_feature_table_ticket(
    request: AmpliconFeatureTableRequest,
    pool: asyncpg.Pool = Depends(get_db_pool),
    signing_key: bytes = Depends(get_flight_signing_key),
    caller: HumanUser = Depends(require_complete_profile),
    _scope: Principal = Depends(require_scope(Scope.PREP_SAMPLE_READ)),
) -> AmpliconFeatureTableTicketResponse:
    """The cohort as signed DoGet tickets — its observations and its ASV chunks —
    and the columns to relabel the observations to, for a client that reads the
    data plane itself and builds the table there (`qiita amplicon feature-table`)."""
    cohort = await _authorized_cohort(pool, caller, request)
    membership_ticket, chunks_ticket = cohort_tickets(cohort, signing_key)
    return AmpliconFeatureTableTicketResponse(
        samples=[
            AmpliconFeatureTableTicketSample(
                **s.column.model_dump(), prep_sample_idx=s.prep_sample_idx
            )
            for s in cohort.samples
        ],
        membership_ticket=base64.b64encode(membership_ticket).decode(),
        chunks_ticket=base64.b64encode(chunks_ticket).decode(),
    )
