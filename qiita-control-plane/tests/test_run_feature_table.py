"""The run feature table's COO: public names only, nothing densified, for an
amplicon run's counts and a taxonomic profile's relative abundances."""

import hashlib

import pyarrow as pa
import pytest
from qiita_common.models.run_feature_table import FeatureTableSample
from qiita_common.taxonomy import RANK_COLUMNS

from qiita_control_plane.run_feature_table import (
    SOURCES,
    Cohort,
    Genomes,
    ProcessedSample,
    arrow_stream_bytes,
    build_features,
    build_values,
)

# A profile's genomes 11, 12, 13 and the handles their exported_feature rows carry.
_LABELS = {11: "G000", 12: "G001", 13: "G002"}
_NO_RANKS = {r: None for r in RANK_COLUMNS}


def _labels(labels=_LABELS):
    return pa.table(
        {
            "genome_idx": pa.array(list(labels), pa.int64()),
            "export_feature_id": pa.array(list(labels.values()), pa.string()),
        }
    )


def build_coo(cohort, values, chunks):
    genomes = Genomes(labels=_labels()) if chunks is None else None
    return (
        build_values(cohort, values, chunks, genomes),
        build_features(cohort, values, chunks, genomes),
    )


def _cohort(*names, method="amplicon"):
    """Processed samples (run 7, prep_sample i) named `names` in order."""
    return Cohort(
        source=SOURCES[method],
        runs=[7],
        samples=[
            ProcessedSample(
                processing_idx=7,
                prep_sample_idx=i,
                column=FeatureTableSample(
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


def _profile(rows):
    return pa.table(
        {
            "prep_sample_idx": pa.array([r[0] for r in rows], pa.int64()),
            "processing_idx": pa.array([7] * len(rows), pa.int64()),
            "taxonomic_abundance": pa.array([r[2] for r in rows], pa.float64()),
            "sequence_abundance": pa.array([r[2] for r in rows], pa.float64()),
            "adjusted_ani": pa.array([0.99] * len(rows), pa.float64()),
            "eff_cov": pa.array([3.0] * len(rows), pa.float64()),
            "genome_idx": pa.array([r[1] for r in rows], pa.int64()),
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
    values, features = build_coo(
        _cohort("QM1", "QM2"),
        _membership([(1, 10, 5), (2, 20, 3)]),
        _chunks([(10, 0, "ACGT"), (10, 1, "ACGT"), (20, 0, "TTTT")]),
    )
    # One row per observation: no zero for QM1 x TTTT or QM2 x ACGTACGT.
    assert sorted(values.to_pylist(), key=lambda r: r["sample"]) == [
        {"sample": "QM1", "feature": md5("ACGTACGT"), "value": 5.0},
        {"sample": "QM2", "feature": md5("TTTT"), "value": 3.0},
    ]
    assert sorted(features.to_pylist(), key=lambda r: r["sequence"]) == [
        {"feature": md5("ACGTACGT"), "sequence": "ACGTACGT", "length": 8, **_NO_RANKS},
        {"feature": md5("TTTT"), "sequence": "TTTT", "length": 4, **_NO_RANKS},
    ]


def test_a_profile_is_named_by_its_genomes_labels_and_carries_no_sequence():
    values, features = build_coo(
        _cohort("QM1", "QM2", method="taxonomic-profile"),
        _profile([(1, 11, 0.8), (1, 12, 0.2), (2, 13, 1.0)]),
        None,
    )
    assert sorted(values.to_pylist(), key=lambda r: (r["sample"], r["feature"])) == [
        {"sample": "QM1", "feature": "G000", "value": 0.8},
        {"sample": "QM1", "feature": "G001", "value": 0.2},
        {"sample": "QM2", "feature": "G002", "value": 1.0},
    ]
    assert features.to_pylist() == [
        {"feature": g, "sequence": None, "length": None, **_NO_RANKS}
        for g in ("G000", "G001", "G002")
    ]


def test_a_genomes_ranks_come_from_its_representative_member():
    """The alignment table's reduction: the lowest classified member speaks for a
    genome, with the source prefixes restored; an unclassified genome is all NULL."""
    members = pa.table(
        {
            "feature_idx": pa.array([101, 102, 103], pa.int64()),
            "genome_idx": pa.array([11, 11, 13], pa.int64()),
        }
    )
    taxonomy = (
        pa.table(
            {
                "feature_idx": pa.array([102], pa.int64()),
                **{r: pa.array([None], pa.string()) for r in RANK_COLUMNS},
            }
        )
        .set_column(1, "domain", pa.array(["Bacteria"]))
        .set_column(7, "species", pa.array(["Burkholderia contaminans"]))
    )
    features = build_features(
        _cohort("QM1", "QM2", method="taxonomic-profile"),
        _profile([(1, 11, 0.5), (2, 13, 1.0)]),
        None,
        Genomes(labels=_labels(), members=members, taxonomy=taxonomy),
    )
    by_feature = {r["feature"]: r for r in features.to_pylist()}
    assert by_feature["G000"]["domain"] == "d__Bacteria"
    assert by_feature["G000"]["species"] == "s__Burkholderia contaminans"
    assert by_feature["G000"]["phylum"] is None
    assert all(by_feature["G002"][r] is None for r in RANK_COLUMNS)


def test_a_value_of_an_unlabelled_genome_is_refused():
    with pytest.raises(RuntimeError, match="no label"):
        build_coo(_cohort("QM1", method="taxonomic-profile"), _profile([(1, 99, 1.0)]), None)


def test_no_internal_identifier_reaches_the_output():
    for cohort, values, chunks in (
        (_cohort("QM1"), _membership([(1, 10, 5)]), _chunks([(10, 0, "ACGT")])),
        (_cohort("QM1", method="taxonomic-profile"), _profile([(1, 11, 1.0)]), None),
    ):
        table, features = build_coo(cohort, values, chunks)
        assert table.column_names == ["sample", "feature", "value"]
        assert features.column_names == ["feature", "sequence", "length", *RANK_COLUMNS]
        # Names travel once, as dictionaries; rows carry codes.
        assert all(
            pa.types.is_dictionary(table.schema.field(c).type) for c in ("sample", "feature")
        )


def test_a_value_of_an_unnamed_sample_is_refused():
    with pytest.raises(RuntimeError, match="no QM"):
        build_coo(_cohort("QM1"), _membership([(2, 10, 5)]), _chunks([(10, 0, "ACGT")]))
    with pytest.raises(RuntimeError, match="no QM"):
        build_coo(_cohort("QM1", method="taxonomic-profile"), _profile([(2, 11, 1.0)]), None)


def test_an_asv_without_a_sequence_is_refused():
    with pytest.raises(RuntimeError, match="no sequence"):
        build_coo(_cohort("QM1"), _membership([(1, 99, 5)]), _chunks([(10, 0, "ACGT")]))


def test_the_values_round_trip_through_an_arrow_stream():
    values, _ = build_coo(_cohort("QM1"), _membership([(1, 10, 5)]), _chunks([(10, 0, "ACGT")]))
    assert pa.ipc.open_stream(arrow_stream_bytes(values)).read_all().equals(values)
