"""The amplicon feature table's COO: public names only, nothing densified."""

import hashlib

import pyarrow as pa
import pytest
from qiita_common.models.amplicon import AmpliconFeatureTableSample

from qiita_control_plane.amplicon_feature_table import (
    Cohort,
    ProcessedSample,
    arrow_stream_bytes,
    build_counts,
    build_features,
)


def build_coo(cohort, membership, chunks):
    return build_counts(cohort, membership, chunks), build_features(chunks)


def _cohort(*names):
    """Processed samples (run 7, prep_sample i) named `names` in order."""
    return Cohort(
        runs=[7],
        samples=[
            ProcessedSample(
                processing_idx=7,
                prep_sample_idx=i,
                column=AmpliconFeatureTableSample(
                    sample=n, export_id=n, biosample=f"QB{i}", processing_idx=7
                ),
            )
            for i, n in enumerate(names, start=1)
        ],
    )


def _membership(rows):
    return pa.table(
        {
            "prep_sample_idx": pa.array([r[0] for r in rows], pa.int64()),
            "processing_idx": pa.array([7] * len(rows), pa.int64()),
            "feature_idx": pa.array([r[1] for r in rows], pa.int64()),
            "count": pa.array([r[2] for r in rows], pa.int64()),
        }
    )


def _chunks(rows):
    return pa.table(
        {
            "feature_idx": pa.array([r[0] for r in rows], pa.int64()),
            "chunk_index": pa.array([r[1] for r in rows], pa.int32()),
            "chunk_data": pa.array([r[2] for r in rows], pa.string()),
        }
    )


def md5(s):
    return hashlib.md5(s.encode()).hexdigest()


def test_counts_are_sparse_and_named_by_column_and_md5():
    counts, features = build_coo(
        _cohort("QM1", "QM2"),
        _membership([(1, 10, 5), (2, 20, 3)]),
        _chunks([(10, 0, "ACGT"), (10, 1, "ACGT"), (20, 0, "TTTT")]),
    )
    # One row per observation: no zero for QM1 x TTTT or QM2 x ACGTACGT.
    assert sorted(counts.to_pylist(), key=lambda r: r["sample"]) == [
        {"sample": "QM1", "feature": md5("ACGTACGT"), "count": 5},
        {"sample": "QM2", "feature": md5("TTTT"), "count": 3},
    ]
    assert sorted(features.to_pylist(), key=lambda r: r["sequence"]) == [
        {"feature": md5("ACGTACGT"), "sequence": "ACGTACGT", "length": 8},
        {"feature": md5("TTTT"), "sequence": "TTTT", "length": 4},
    ]


def test_no_internal_identifier_reaches_the_output():
    counts, features = build_coo(
        _cohort("QM1"), _membership([(1, 10, 5)]), _chunks([(10, 0, "ACGT")])
    )
    assert counts.column_names == ["sample", "feature", "count"]
    assert features.column_names == ["feature", "sequence", "length"]
    # Names travel once, as dictionaries; rows carry codes.
    assert all(pa.types.is_dictionary(counts.schema.field(c).type) for c in ("sample", "feature"))


def test_an_observation_of_an_unnamed_sample_is_refused():
    with pytest.raises(RuntimeError, match="no QM"):
        build_coo(_cohort("QM1"), _membership([(2, 10, 5)]), _chunks([(10, 0, "ACGT")]))


def test_an_asv_without_a_sequence_is_refused():
    with pytest.raises(RuntimeError, match="no sequence"):
        build_coo(_cohort("QM1"), _membership([(1, 99, 5)]), _chunks([(10, 0, "ACGT")]))


def test_the_counts_round_trip_through_an_arrow_stream():
    counts, _ = build_coo(_cohort("QM1"), _membership([(1, 10, 5)]), _chunks([(10, 0, "ACGT")]))
    assert pa.ipc.open_stream(arrow_stream_bytes(counts)).read_all().equals(counts)
