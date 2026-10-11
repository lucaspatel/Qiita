"""An amplicon feature table: a query over a cohort, answered as sparse COO.

A feature table is not a run's artifact. It is a selection — one or more amplicon
runs, over a study's samples or a named list — of the observations the lake
already holds as COO rows (`amplicon_membership`: one row per processed sample
and ASV, with its count). Merging runs or building from many samples is that
selection, nothing more, because ASVs are content-deduped into one feature space:
the same sequence found by two runs is one feature.

Three steps, each testable alone:
  * `resolve_cohort` picks the processed samples (one run's view of one
    prep_sample) the request names and gives each a public column name;
  * `fetch_amplicon_runs` reads their observations and the ASV bytes from the
    data plane under one signed ticket shape;
  * `build_coo` turns those into the counts `(sample, feature, count)` and the
    features `(feature, sequence, length)`, public handles only.

Nothing is made dense: a rapid-16S pool is ~8% dense, and density falls as runs
and samples are added. Internal idxs are join keys and never reach the output.
"""

from __future__ import annotations

import io
import json
from dataclasses import dataclass

import asyncpg
import duckdb
import pyarrow as pa
import pyarrow.flight as flight
from qiita_common.actions import AMPLICON_ACTION_ID
from qiita_common.amplicon_constants import (
    AMPLICON_MEMBERSHIP_TABLE,
    AMPLICON_SEQUENCE_CHUNKS_TABLE,
)
from qiita_common.models.amplicon import AmpliconFeatureTableRequest, AmpliconFeatureTableSample

from .auth.tickets import sign_ticket
from .sample_names import BIOSAMPLE_NAME_JOIN, BIOSAMPLE_NAME_SQL

ARROW_STREAM_MEDIA_TYPE = "application/vnd.apache.arrow.stream"

# The params whose difference makes two runs' ASVs incomparable: the trim length
# is the ASV's length, and orientation decides which strand it is read on. ASVs
# from runs differing in these are different features, so merging them would
# yield disjoint blocks under one table's name. Other params (the SortMeRNA
# reference, the workflow version) change which reads survive, not what an ASV is.
MERGE_KEYS = ("trim", "orient_primer")

# Dictionary-encoded names: each sample and feature id is sent once, and each row
# carries two small integer codes and its count. Plain strings would repeat a
# 32-character md5 per observation, making the stream larger than a dense TSV.
_NAME = pa.dictionary(pa.int32(), pa.string())
COUNTS_SCHEMA = pa.schema([("sample", _NAME), ("feature", _NAME), ("count", pa.int64())])
FEATURES_SCHEMA = pa.schema(
    [("feature", pa.string()), ("sequence", pa.string()), ("length", pa.int32())]
)


class CohortError(Exception):
    """A request the cohort cannot answer; `status` is the HTTP status it maps to."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


@dataclass(frozen=True)
class ProcessedSample:
    processing_idx: int
    prep_sample_idx: int
    column: AmpliconFeatureTableSample


@dataclass(frozen=True)
class Cohort:
    runs: list[int]
    samples: list[ProcessedSample]

    @property
    def prep_sample_idxs(self) -> list[int]:
        return sorted({s.prep_sample_idx for s in self.samples})


def _params(row: asyncpg.Record) -> dict:
    params = row["params"]
    return json.loads(params) if isinstance(params, str) else (params or {})


async def resolve_cohort(pool: asyncpg.Pool, request: AmpliconFeatureTableRequest) -> Cohort:
    """The processed samples `request` names, each with its column name.

    The runs must all be amplicon runs and mergeable (`MERGE_KEYS`). A processed
    sample is a live QM (`exported_identifier`) of one of the runs — the workflow
    mints one per sample it counted — whose prep_sample is in the named study (live
    link) or the named list, and not ENA-flagged. A named list that includes a
    prep_sample none of the runs counted is refused rather than trimmed.
    """
    runs = sorted(set(request.processing_idx))
    rows = await pool.fetch(
        "SELECT processing_idx, workflow, params FROM qiita.processing"
        " WHERE processing_idx = ANY($1::bigint[])",
        runs,
    )
    found = {r["processing_idx"]: r for r in rows}
    unknown = [p for p in runs if p not in found or found[p]["workflow"] != AMPLICON_ACTION_ID]
    if unknown:
        raise CohortError(404, f"not amplicon runs: processing_idx {unknown}")
    settings = {p: tuple(_params(found[p]).get(k) for k in MERGE_KEYS) for p in runs}
    if len(set(settings.values())) > 1:
        detail = "; ".join(
            f"{p}: " + ", ".join(f"{k}={v}" for k, v in zip(MERGE_KEYS, s, strict=True))
            for p, s in settings.items()
        )
        raise CohortError(
            409,
            f"these runs' ASVs are not comparable ({', '.join(MERGE_KEYS)} differ): {detail}",
        )

    processed = await pool.fetch(
        "SELECT ei.processing_idx, ei.prep_sample_idx, ei.export_id,"
        "       COALESCE(b.biosample_accession, b.ena_sample_accession) AS accession,"
        f"      {BIOSAMPLE_NAME_SQL} AS biosample"
        "  FROM qiita.exported_identifier ei"
        "  JOIN qiita.prep_sample ps ON ps.idx = ei.prep_sample_idx"
        "  JOIN qiita.biosample b ON b.idx = ps.biosample_idx"
        f" {BIOSAMPLE_NAME_JOIN}"
        "  LEFT JOIN qiita.sequenced_sample ss ON ss.prep_sample_idx = ps.idx"
        " WHERE ei.processing_idx = ANY($1::bigint[]) AND NOT ei.retired"
        "   AND ss.ena_status IS NULL"
        "   AND ($2::bigint IS NULL OR EXISTS ("
        "     SELECT 1 FROM qiita.prep_sample_to_study pst"
        "      WHERE pst.prep_sample_idx = ps.idx AND pst.study_idx = $2 AND NOT pst.retired))"
        "   AND ($3::bigint[] IS NULL OR ps.idx = ANY($3::bigint[]))"
        " ORDER BY ei.prep_sample_idx, ei.processing_idx",
        runs,
        request.study_idx,
        request.prep_sample_idx,
    )
    if request.prep_sample_idx is not None:
        uncounted = sorted(set(request.prep_sample_idx) - {r["prep_sample_idx"] for r in processed})
        if uncounted:
            raise CohortError(
                404,
                f"{len(uncounted)} named prep_sample(s) were not counted by these runs"
                f" (prep_sample_idx {uncounted[:5]})",
            )
    if not processed:
        raise CohortError(404, "these runs counted none of the named samples")
    if any(r["biosample"] is None for r in processed):
        raise RuntimeError("a counted sample's biosample has no accession and no QB")

    # A deposited accession names one column only when no other column of this
    # table shares it (one biosample, one processed sample); otherwise each of
    # those columns falls back to its own QM, so the two stay distinguishable.
    per_accession: dict[str, int] = {}
    for r in processed:
        if r["accession"]:
            per_accession[r["accession"]] = per_accession.get(r["accession"], 0) + 1
    samples = [
        ProcessedSample(
            processing_idx=r["processing_idx"],
            prep_sample_idx=r["prep_sample_idx"],
            column=AmpliconFeatureTableSample(
                sample=(
                    r["accession"]
                    if r["accession"] and per_accession[r["accession"]] == 1
                    else r["export_id"]
                ),
                export_id=r["export_id"],
                biosample=r["biosample"],
                processing_idx=r["processing_idx"],
            ),
        )
        for r in processed
    ]
    return Cohort(runs=runs, samples=samples)


def fetch_amplicon_runs(
    *,
    data_plane_url: str,
    signing_key: bytes,
    processing_idxs: list[int],
    prep_sample_idxs: list[int],
) -> tuple[pa.Table, pa.Table]:
    """Read the runs' observations over the cohort, and the ASV chunks they name.
    Blocking (Flight is synchronous); callers run it off the event loop."""
    scope = {"processing_idx": processing_idxs, "prep_sample_idx": prep_sample_idxs}
    tables = []
    with flight.FlightClient(data_plane_url) as client:
        for table in (AMPLICON_MEMBERSHIP_TABLE, AMPLICON_SEQUENCE_CHUNKS_TABLE):
            ticket = sign_ticket(table=table, filter=scope, secret=signing_key)
            tables.append(client.do_get(flight.Ticket(ticket)).read_all())
    return tables[0], tables[1]


def build_coo(cohort: Cohort, membership: pa.Table, chunks: pa.Table) -> tuple[pa.Table, pa.Table]:
    """The counts `(sample, feature, count)` and the features `(feature, sequence,
    length)`, where `sample` is a column name from `cohort` and `feature` is the
    md5 of the ASV's sequence (the QIIME 2 / Greengenes2 feature id). Refuses
    rather than guesses: an observation of a processed sample the cohort did not
    name, or an ASV with no sequence, would need an internal idx as its name."""
    names = pa.table(
        {
            "processing_idx": pa.array([s.processing_idx for s in cohort.samples], pa.int64()),
            "prep_sample_idx": pa.array([s.prep_sample_idx for s in cohort.samples], pa.int64()),
            "sample": pa.array([s.column.sample for s in cohort.samples], pa.string()),
        }
    )
    with duckdb.connect() as duck:
        duck.register("membership", membership)
        duck.register("chunks", chunks)
        duck.register("names", names)
        unnamed = duck.execute(
            "SELECT count(*) FROM membership m"
            " ANTI JOIN names n USING (processing_idx, prep_sample_idx)"
        ).fetchone()[0]
        if unnamed:
            raise RuntimeError(f"{unnamed} observation(s) of a processed sample with no QM")
        duck.execute(
            "CREATE TEMP TABLE feature AS"
            " SELECT feature_idx, md5(seq) AS feature, seq AS sequence,"
            "        length(seq)::INTEGER AS length"
            " FROM (SELECT feature_idx, string_agg(chunk_data, '' ORDER BY chunk_index) AS seq"
            "       FROM chunks GROUP BY feature_idx)"
        )
        missing = duck.execute(
            "SELECT count(DISTINCT feature_idx) FROM membership"
            " ANTI JOIN feature USING (feature_idx)"
        ).fetchone()[0]
        if missing:
            raise RuntimeError(f"{missing} observed ASV(s) have no sequence in the lake")
        counts = duck.execute(
            "SELECT n.sample, f.feature, sum(m.count)::BIGINT AS count"
            " FROM membership m"
            " JOIN names n USING (processing_idx, prep_sample_idx)"
            " JOIN feature f USING (feature_idx)"
            " GROUP BY n.sample, f.feature ORDER BY n.sample, f.feature"
        ).to_arrow_table()
        features = duck.execute(
            "SELECT feature, sequence, length FROM feature"
            " WHERE feature_idx IN (SELECT feature_idx FROM membership) ORDER BY feature"
        ).to_arrow_table()
    return counts.cast(COUNTS_SCHEMA), features.cast(FEATURES_SCHEMA)


def arrow_stream_bytes(table: pa.Table) -> bytes:
    """`table` as an Arrow IPC stream: what the counts and features routes send."""
    sink = io.BytesIO()
    with pa.ipc.new_stream(sink, table.schema) as writer:
        writer.write_table(table)
    return sink.getvalue()
