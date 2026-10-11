"""qiita user CLI — the client-side amplicon feature table.

`qiita feature-table amplicon` builds an ASV feature table on the caller's own
machine, the way `feature-table build` builds a genome table: the control plane
authorizes the cohort and signs two Flight tickets (the observations and the ASV
bytes), the data plane streams them, and the relabel and the write happen in the
caller's DuckDB under the caller's credentials. Nothing is computed server-side
and nothing is stored there.

The table is written straight from its sparse COO rows — BIOM and Parquet both
take `(feature_id, sample_id, value)` — so it is never made dense on the way to
disk. The relabel itself (md5 feature ids, public column names) is the control
plane's `stage_features` / `stage_counts`, shared with the REST answer, so the
two cannot disagree about a table.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import sys
from pathlib import Path
from typing import Any

from qiita_common import analytic as ft
from qiita_common.api_paths import PATH_AMPLICON_FEATURE_TABLE_TICKET, PATH_AMPLICON_PREFIX
from qiita_common.models.amplicon import AmpliconFeatureTableRequest

from ...amplicon_feature_table import COUNT_RELATION, stage_counts, stage_features
from .. import _common
from .feature_table import (
    IDENTIFIER_MAP_NOTE,
    SEQUENCES_COMPANION,
    SequencesClearance,
    _bundle_targets,
    _registered,
    _tool_versions,
    _write_bundle,
    staged_stream,
)

MANIFEST_NOTE = (
    "This file records what produced the table beside it: the amplicon runs and the"
    " samples it was built over. A feature table is a selection over the lake, so the"
    " same runs over a different cohort yield a different table — which is why this"
    " record is part of the bundle."
)


def _request(args: argparse.Namespace) -> AmpliconFeatureTableRequest:
    return AmpliconFeatureTableRequest(
        processing_idx=args.processing_idx,
        study_idx=args.study_idx,
        prep_sample_idx=args.prep_sample_idx,
    )


def _build(args: argparse.Namespace, token: str, con) -> tuple[list[Path], dict[str, int]]:
    """Fetch the tickets, stream the cohort, relabel, and write the bundle."""
    import pyarrow as pa  # noqa: PLC0415
    import pyarrow.flight as flight  # noqa: PLC0415

    request = _request(args)
    response = _common.call(
        "POST",
        args.base_url,
        token,
        f"{PATH_AMPLICON_PREFIX}{PATH_AMPLICON_FEATURE_TABLE_TICKET}",
        json=request.model_dump(exclude_none=True),
    )
    samples: list[dict[str, Any]] = response["samples"]
    names = pa.table(
        {
            "processing_idx": pa.array([s["processing_idx"] for s in samples], pa.int64()),
            "prep_sample_idx": pa.array([s["prep_sample_idx"] for s in samples], pa.int64()),
            "sample": pa.array([s["sample"] for s in samples], pa.string()),
        }
    )
    with flight.FlightClient(args.data_plane_url) as client:
        # Each stream is read once, into a table: the relabel scans both twice.
        for key, relation in (("membership_ticket", "membership"), ("chunks_ticket", "chunks")):
            ticket = base64.b64decode(response[key])
            with staged_stream(con, client, ticket, relation=f"{relation}_stream") as source:
                con.execute(f"CREATE TEMP TABLE {relation} AS SELECT * FROM {source}")
    with _registered(con, "names", names):
        stage_features(con, chunks="chunks")
        stage_counts(con, names="names", membership="membership")
    con.execute(
        f"CREATE TEMP TABLE {ft.LABELLED_RELATION} AS"
        " SELECT feature AS feature_id, sample AS sample_id, count::DOUBLE AS value"
        f" FROM {COUNT_RELATION} ORDER BY sample_id, feature_id"
    )
    sizes = dict(
        zip(
            ("observations", "samples", "features"),
            con.execute(
                "SELECT count(*), count(DISTINCT sample_id), count(DISTINCT feature_id)"
                f" FROM {ft.LABELLED_RELATION}"
            ).fetchone(),
            strict=True,
        )
    )

    def manifest(targets: list[Path]) -> dict[str, Any]:
        return {
            "note": MANIFEST_NOTE,
            "kind": "amplicon",
            "request": request.model_dump(exclude_none=True),
            "feature_id": "md5 of the ASV sequence",
            **sizes,
            "files": [p.name for p in targets],
            "versions": _tool_versions(con),
        }

    written = _write_bundle(
        con,
        table_path=args.output,
        fmt=args.format,
        identifiers=samples,
        manifest=manifest,
        clearances={"sequences": SequencesClearance(features=sizes["features"])},
    )
    return written, sizes


def _handle_amplicon_feature_table(
    args: argparse.Namespace, parser: argparse.ArgumentParser
) -> int:
    """Entry point for `qiita feature-table amplicon`. Fails loudly (exit 1) on the
    first refusal; a failure part-way leaves no bundle file behind."""
    import duckdb  # noqa: PLC0415
    import pyarrow.flight as flight  # noqa: PLC0415
    from pydantic import ValidationError  # noqa: PLC0415

    from ...miint import connect_with_miint  # noqa: PLC0415

    try:
        token = _common.read_token()
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    try:
        # The refusals that need only the flags, before a connection or a stream.
        _request(args)
        _bundle_targets(args.output, args.format, companions=(SEQUENCES_COMPANION,))
        with contextlib.closing(connect_with_miint()) as con:
            written, sizes = _build(args, token, con)
    except ValidationError as exc:
        print(f"error: {exc.errors()[0]['msg']}", file=sys.stderr)
        return 1
    except _common.httpx.HTTPStatusError as exc:
        print(f"http error {exc.response.status_code}: {exc.response.text}", file=sys.stderr)
        return 1
    except _common.httpx.RequestError as exc:
        print(
            f"error: could not reach the control plane: {exc!r}. Check --base-url /"
            " $QIITA_CONTROL_PLANE_URL.",
            file=sys.stderr,
        )
        return 1
    except flight.FlightError as exc:
        print(f"flight error: {exc}", file=sys.stderr)
        return 1
    except duckdb.Error as exc:
        print(f"error: building the table failed on this machine: {exc}", file=sys.stderr)
        return 1
    except (ValueError, OSError, RuntimeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    table_path, map_path, manifest_path, sequences_path = written
    print(
        f"wrote {sizes['samples']} sample(s) x {sizes['features']} feature(s),"
        f" {sizes['observations']} observation(s), to {table_path} ({args.format})"
    )
    print(f"and the map needed to read it: {map_path}")
    print(f"and the record of what produced it: {manifest_path}")
    print(f"and each feature's sequence: {sequences_path}")
    print(IDENTIFIER_MAP_NOTE)
    return 0
