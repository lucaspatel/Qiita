"""qiita user CLI — the client-side run feature table.

`qiita feature-table runs` builds a feature table from processing runs on the
caller's own machine, the way `feature-table build` builds a genome table: the
control plane authorizes the cohort and signs Flight tickets (the values, and an
amplicon table's ASV bytes), the data plane streams them, and the relabel and the
write happen in the caller's DuckDB under the caller's credentials. Nothing is
computed server-side and nothing is stored there.

A run is an amplicon run (ASV counts, features named by sequence md5) or a
taxonomic profile (relative abundances, features named by the profiling
database's genome identifiers). The table is written straight from its sparse COO
rows — BIOM and Parquet both take `(feature_id, sample_id, value)` — so it is never
made dense on the way to disk. The relabel itself is the control plane's
`stage_values`, shared with the REST answer, so the two cannot disagree about a
table.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import sys
from pathlib import Path
from typing import Any

from qiita_common import analytic as ft
from qiita_common.api_paths import PATH_FEATURE_TABLE_PREFIX, PATH_FEATURE_TABLE_TICKET
from qiita_common.models.run_feature_table import FeatureTableRequest

from ...run_feature_table import SOURCES, VALUE_RELATION, stage_values
from .. import _common
from .feature_table import (
    IDENTIFIER_MAP_NOTE,
    SequencesClearance,
    _bundle_targets,
    _registered,
    _tool_versions,
    _write_bundle,
    staged_stream,
)

MANIFEST_NOTE = (
    "This file records what produced the table beside it: the runs and the samples it"
    " was built over. A feature table is a selection over the lake, so the same runs"
    " over a different cohort yield a different table — which is why this record is"
    " part of the bundle."
)

# What each method's feature ids are, for the manifest.
_FEATURE_ID = {
    "amplicon": "md5 of the ASV sequence",
    "taxonomic-profile": "the profiling database's genome identifier",
}


def _request(args: argparse.Namespace) -> FeatureTableRequest:
    return FeatureTableRequest(
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
        f"{PATH_FEATURE_TABLE_PREFIX}{PATH_FEATURE_TABLE_TICKET}",
        json=request.model_dump(exclude_none=True),
    )
    source = SOURCES[response["method"]]
    samples: list[dict[str, Any]] = response["samples"]
    names = pa.table(
        {
            "processing_idx": pa.array([s["processing_idx"] for s in samples], pa.int64()),
            "prep_sample_idx": pa.array([s["prep_sample_idx"] for s in samples], pa.int64()),
            "sample": pa.array([s["sample"] for s in samples], pa.string()),
        }
    )
    streams = [("values_ticket", "run_values")]
    if response["sequences_ticket"] is not None:
        streams.append(("sequences_ticket", "chunks"))
    with flight.FlightClient(args.data_plane_url) as client:
        # Each stream is read once, into a table: the relabel scans both twice.
        for key, relation in streams:
            ticket = base64.b64decode(response[key])
            with staged_stream(con, client, ticket, relation=f"{relation}_stream") as stream:
                con.execute(f"CREATE TEMP TABLE {relation} AS SELECT * FROM {stream}")
    with _registered(con, "names", names):
        stage_values(
            con,
            source=source,
            names="names",
            values="run_values",
            chunks="chunks" if len(streams) == 2 else None,
        )
    con.execute(
        f"CREATE TEMP TABLE {ft.LABELLED_RELATION} AS"
        " SELECT feature AS feature_id, sample AS sample_id, value"
        f" FROM {VALUE_RELATION} ORDER BY sample_id, feature_id"
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
            "kind": source.method,
            "value_kind": source.value_kind,
            "request": request.model_dump(exclude_none=True),
            "feature_id": _FEATURE_ID[source.method],
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
        clearances=(
            {"sequences": SequencesClearance(features=sizes["features"])}
            if source.sequences_table is not None
            else {}
        ),
    )
    return written, sizes


def _handle_run_feature_table(args: argparse.Namespace, parser: argparse.ArgumentParser) -> int:
    """Entry point for `qiita feature-table runs`. Fails loudly (exit 1) on the
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
        # The method, and so whether a sequences companion is written, is known
        # only from the ticket; the write checks the whole bundle again.
        _request(args)
        _bundle_targets(args.output, args.format)
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

    table_path, map_path, manifest_path, *companions = written
    print(
        f"wrote {sizes['samples']} sample(s) x {sizes['features']} feature(s),"
        f" {sizes['observations']} observation(s), to {table_path} ({args.format})"
    )
    print(f"and the map needed to read it: {map_path}")
    print(f"and the record of what produced it: {manifest_path}")
    for path in companions:
        print(f"and each feature's sequence: {path}")
    print(IDENTIFIER_MAP_NOTE)
    return 0
