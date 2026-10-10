"""The amplicon feature table's rendering: ASV sequences by QM-labelled samples."""

import pyarrow as pa
import pytest

from qiita_control_plane.amplicon_feature_table import render_feature_table_tsv


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


def test_rows_are_asv_sequences_and_columns_are_export_ids():
    membership = _membership([(1, 100, 5), (1, 200, 2), (2, 200, 9)])
    # feature 200's sequence spans two chunks, out of order on the wire.
    chunks = _chunks([(100, 0, "TTTT"), (200, 1, "GG"), (200, 0, "AACC")])
    tsv = render_feature_table_tsv(membership, chunks, {1: "QM10", 2: "QM11"})
    assert tsv.splitlines() == [
        "#OTU ID\tQM10\tQM11",
        "AACCGG\t2\t9",
        "TTTT\t5\t0",
    ]


def test_no_internal_identifier_reaches_the_table():
    membership = _membership([(41, 9001, 3)])
    chunks = _chunks([(9001, 0, "ACGT")])
    tsv = render_feature_table_tsv(membership, chunks, {41: "QM5"})
    assert "41" not in tsv
    assert "9001" not in tsv


def test_a_sample_with_no_asvs_is_an_all_zero_column():
    membership = _membership([(1, 100, 5)])
    chunks = _chunks([(100, 0, "ACGT")])
    tsv = render_feature_table_tsv(membership, chunks, {1: "QM1", 2: "QM2"})
    assert tsv.splitlines() == ["#OTU ID\tQM1\tQM2", "ACGT\t5\t0"]


def test_an_asv_without_a_sequence_is_refused():
    with pytest.raises(RuntimeError, match="no sequence"):
        render_feature_table_tsv(_membership([(1, 100, 5)]), _chunks([]), {1: "QM1"})


def test_a_counted_sample_without_a_label_is_refused():
    """A row whose sample has no public label would need an internal id to print."""
    with pytest.raises(RuntimeError, match="no export_id"):
        render_feature_table_tsv(
            _membership([(1, 100, 5), (3, 100, 1)]), _chunks([(100, 0, "A")]), {1: "QM1"}
        )
