"""The run feature table over REST: one cohort request, three answers.

`POST /feature-table/{samples,values,features}` all take the same body
(`FeatureTableRequest`: runs, and a study or a sample list) and answer:

  * samples — the table's columns as JSON: each processed sample's column name,
    its QM, its biosample's public name (to join to metadata), and its run; with
    the runs' method and what their values are (`count` or `relative_abundance`);
  * values — sparse COO `(sample, feature, value)` as an Arrow IPC stream;
  * features — `(feature, sequence, length, <eight ranks>)` for every feature the
    values name, as an Arrow IPC stream: an ASV's sequence, or a genome's taxonomy
    from its reference.

A request naming `filter_reference_idx` gets an amplicon table cut to the ASVs that
are members of that reference, ranked by its taxonomy: a view, computed per read.

What a feature table is, which runs it can merge, and why COO, is in
`run_feature_table`. Arrow IPC keeps the same columnar rows a Flight reader gets,
for the web UI and the CLI alike.

Access is `authorize_prep_sample_cohort`, all-or-nothing over the cohort, at the
tier the other cohort reads use, checked before anything is read from the data
plane. The data plane serves exactly the cohort the ticket carries, so that gate
is the authorization boundary.
"""

import asyncio

import asyncpg
import pyarrow as pa
import pyarrow.flight as flight
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from qiita_common.api_paths import (
    PATH_FEATURE_TABLE_FEATURES,
    PATH_FEATURE_TABLE_PREFIX,
    PATH_FEATURE_TABLE_SAMPLES,
    PATH_FEATURE_TABLE_VALUES,
)
from qiita_common.auth_constants import Scope
from qiita_common.models.run_feature_table import FeatureTableRequest, FeatureTableSamples

from ..auth.guards import COHORT_MIN_TIER, require_complete_profile, require_scope
from ..auth.principal import HumanUser, Principal
from ..deps import get_data_plane_url, get_db_pool, get_flight_signing_key
from ..run_feature_table import (
    ARROW_STREAM_MEDIA_TYPE,
    Cohort,
    CohortError,
    Genomes,
    Kept,
    arrow_stream_bytes,
    build_features,
    build_values,
    fetch_runs,
    fetch_taxonomy,
    genome_labels,
    genome_members,
    observed_genomes,
    reference_members,
    resolve_cohort,
)
from ._helpers import authorize_prep_sample_cohort

router = APIRouter(prefix=PATH_FEATURE_TABLE_PREFIX, tags=["feature-table"])


async def _authorized_cohort(
    pool: asyncpg.Pool, caller: HumanUser, request: FeatureTableRequest
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
    cohort: Cohort, data_plane_url: str, signing_key: bytes, *, values: bool
) -> tuple[pa.Table | None, pa.Table | None]:
    try:
        return await asyncio.to_thread(
            lambda: fetch_runs(
                data_plane_url=data_plane_url,
                signing_key=signing_key,
                cohort=cohort,
                values=values,
            )
        )
    except flight.FlightError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"data plane read of the {cohort.source.method} runs failed: {exc}",
        ) from exc


@router.post(PATH_FEATURE_TABLE_SAMPLES)
async def feature_table_samples(
    request: FeatureTableRequest,
    pool: asyncpg.Pool = Depends(get_db_pool),
    caller: HumanUser = Depends(require_complete_profile),
    _scope: Principal = Depends(require_scope(Scope.PREP_SAMPLE_READ)),
) -> FeatureTableSamples:
    """The table's columns: one per processed sample the request names."""
    cohort = await _authorized_cohort(pool, caller, request)
    return FeatureTableSamples(
        method=cohort.source.method,
        value_kind=cohort.source.value_kind,
        samples=[s.column for s in cohort.samples],
    )


async def _genomes(
    pool: asyncpg.Pool,
    cohort: Cohort,
    values: pa.Table,
    caller: HumanUser,
    *,
    taxonomy: bool,
    data_plane_url: str,
    signing_key: bytes,
) -> Genomes | None:
    """What a genome-keyed table names its features with (and, for `taxonomy`, ranks
    them by); None for a table whose features are ASVs."""
    if cohort.source.feature_key != "genome_idx":
        return None
    observed = observed_genomes(values)
    labels = await genome_labels(pool, observed, caller.principal_idx)
    if not taxonomy:
        return Genomes(labels=labels)
    if cohort.reference_idx is None:
        raise RuntimeError(f"a {cohort.source.method} run names no reference")
    members = await genome_members(pool, cohort.reference_idx, observed)
    try:
        ranks = await asyncio.to_thread(
            lambda: fetch_taxonomy(
                data_plane_url=data_plane_url,
                signing_key=signing_key,
                reference_idx=cohort.reference_idx,
                feature_idx=members.column("feature_idx").to_pylist(),
            )
        )
    except flight.FlightError as exc:
        raise HTTPException(
            status_code=502, detail=f"data plane read of the reference's taxonomy failed: {exc}"
        ) from exc
    return Genomes(labels=labels, members=members, taxonomy=ranks)


async def _kept(
    pool: asyncpg.Pool,
    cohort: Cohort,
    observed: pa.Table,
    *,
    taxonomy: bool,
    data_plane_url: str,
    signing_key: bytes,
) -> Kept | None:
    """The ASVs of `observed` (any relation with `feature_idx`) the cohort's filter
    reference keeps, with their taxonomy for `taxonomy`; None when unfiltered."""
    if cohort.filter_reference_idx is None:
        return None
    features = await reference_members(
        pool,
        cohort.filter_reference_idx,
        sorted(set(observed.column("feature_idx").to_pylist())),
    )
    if not taxonomy:
        return Kept(features=features)
    kept_idx = features.column("feature_idx").to_pylist()
    if not kept_idx:
        # An empty filter would sign a ticket for the reference's whole taxonomy.
        return Kept(features=features)
    try:
        ranks = await asyncio.to_thread(
            lambda: fetch_taxonomy(
                data_plane_url=data_plane_url,
                signing_key=signing_key,
                reference_idx=cohort.filter_reference_idx,
                feature_idx=kept_idx,
            )
        )
    except flight.FlightError as exc:
        raise HTTPException(
            status_code=502, detail=f"data plane read of the filter's taxonomy failed: {exc}"
        ) from exc
    return Kept(features=features, taxonomy=ranks)


@router.post(PATH_FEATURE_TABLE_VALUES, response_class=Response)
async def feature_table_values(
    request: FeatureTableRequest,
    pool: asyncpg.Pool = Depends(get_db_pool),
    signing_key: bytes = Depends(get_flight_signing_key),
    data_plane_url: str = Depends(get_data_plane_url),
    caller: HumanUser = Depends(require_complete_profile),
    _scope: Principal = Depends(require_scope(Scope.PREP_SAMPLE_READ)),
) -> Response:
    """The values as sparse COO `(sample, feature, value)`, an Arrow IPC stream."""
    cohort = await _authorized_cohort(pool, caller, request)
    values, chunks = await _read(cohort, data_plane_url, signing_key, values=True)
    genomes = await _genomes(
        pool,
        cohort,
        values,
        caller,
        taxonomy=False,
        data_plane_url=data_plane_url,
        signing_key=signing_key,
    )
    kept = await _kept(
        pool,
        cohort,
        values,
        taxonomy=False,
        data_plane_url=data_plane_url,
        signing_key=signing_key,
    )
    table = build_values(cohort, values, chunks, genomes, kept)
    return Response(arrow_stream_bytes(table), media_type=ARROW_STREAM_MEDIA_TYPE)


@router.post(PATH_FEATURE_TABLE_FEATURES, response_class=Response)
async def feature_table_features(
    request: FeatureTableRequest,
    pool: asyncpg.Pool = Depends(get_db_pool),
    signing_key: bytes = Depends(get_flight_signing_key),
    data_plane_url: str = Depends(get_data_plane_url),
    caller: HumanUser = Depends(require_complete_profile),
    _scope: Principal = Depends(require_scope(Scope.PREP_SAMPLE_READ)),
) -> Response:
    """Every feature the values name, `(feature, sequence, length, <ranks>)`, an
    Arrow IPC stream. An amplicon table reads only its ASV chunks (the ticket
    already scopes them to the ASVs the cohort observed); a genome-keyed one reads
    its values, then its genomes' taxonomy from their reference."""
    cohort = await _authorized_cohort(pool, caller, request)
    needs_values = cohort.source.sequences_table is None
    values, chunks = await _read(cohort, data_plane_url, signing_key, values=needs_values)
    genomes = (
        await _genomes(
            pool,
            cohort,
            values,
            caller,
            taxonomy=True,
            data_plane_url=data_plane_url,
            signing_key=signing_key,
        )
        if values is not None
        else None
    )
    kept = (
        await _kept(
            pool,
            cohort,
            chunks,
            taxonomy=True,
            data_plane_url=data_plane_url,
            signing_key=signing_key,
        )
        if chunks is not None
        else None
    )
    table = build_features(cohort, values, chunks, genomes, kept)
    return Response(arrow_stream_bytes(table), media_type=ARROW_STREAM_MEDIA_TYPE)
