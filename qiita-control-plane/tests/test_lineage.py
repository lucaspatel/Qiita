"""`build_study_lineage`: rows from the gates become one DAG per prep protocol."""

import pytest

from qiita_control_plane.lineage import build_study_lineage


def _sample(idx, protocol, *, pool=7, run=3, label=None, read_count=100, item="1"):
    return {
        "prep_sample_idx": idx,
        "biosample_idx": 100 + idx,
        "prep_protocol": protocol,
        "sequenced_pool_idx": pool,
        "sequencing_run_idx": run,
        "sequenced_pool_item_id": item,
        "label": label or f"QB{idx}",
        "label_source": "biosample_accession" if label else "export_entity_id",
        "read_count": read_count,
    }


def _rows(**kw):
    return {
        "samples": [],
        "ingest": [],
        "masks": [],
        "assemblies": [],
        "amplicons": [],
        "profiles": [],
        **kw,
    }


def _amplicon(idx, state, asv_count=None, processing_idx=11):
    return {
        "processing_idx": processing_idx,
        "prep_sample_idx": idx,
        "state": state,
        "asv_count": asv_count,
        "workflow": "amplicon",
        "version": "1.1.0",
    }


def test_amplicon_samples_form_run_reads_asvs_feature_table():
    rows = _rows(
        samples=[
            _sample(1, "short_read_amplicon", label="SAMEA1"),
            _sample(2, "short_read_amplicon", read_count=250),
            _sample(3, "short_read_amplicon", read_count=None),
        ],
        ingest=[{"sequenced_pool_idx": 7, "action_id": "golay-demux", "state": "completed"}],
        amplicons=[_amplicon(1, "completed", 40), _amplicon(2, "no_data")],
    )
    (group,) = build_study_lineage(9, rows).groups
    assert group.prep_protocol == "short_read_amplicon"
    nodes = {n.id: n for n in group.nodes}
    assert list(nodes) == ["run", "reads", "processing:11", "feature_table:11"]
    assert [n.label for n in nodes.values()] == ["Run", "Reads", "ASVs", "Feature table"]
    assert nodes["reads"].detail == "golay-demux"
    assert nodes["processing:11"].detail == "amplicon 1.1.0"
    assert nodes["reads"].counts == {"completed": 2, "no_data": 1}
    assert nodes["processing:11"].counts == {"completed": 1, "no_data": 1, "not_started": 1}
    assert nodes["processing:11"].value_label == "ASVs"
    assert nodes["feature_table:11"].counts == {"completed": 1}
    assert [(e.source, e.target) for e in group.edges] == [
        ("run", "reads"),
        ("reads", "processing:11"),
        ("processing:11", "feature_table:11"),
    ]
    by_idx = {s.prep_sample_idx: s for s in group.samples}
    assert by_idx[1].label == "SAMEA1"
    assert by_idx[2].label == "QB2"
    assert by_idx[1].label_source == "biosample_accession"
    assert by_idx[2].label_source == "export_entity_id"
    assert by_idx[1].cells["processing:11"].value == 40
    assert by_idx[2].cells["reads"].value == 250
    assert nodes["reads"].value_label == "Reads"
    assert "processing:11" not in by_idx[3].cells


def test_protocols_get_separate_dags():
    rows = _rows(
        samples=[_sample(1, "short_read_amplicon"), _sample(2, "long_read_metagenomics")],
        amplicons=[_amplicon(1, "completed", 5)],
        masks=[{"mask_idx": 4, "prep_sample_idx": 2, "state": "completed"}],
        assemblies=[
            {
                "processing_idx": 12,
                "prep_sample_idx": 2,
                "state": "pending",
                "workflow": "long-read-assembly",
                "version": "1.0.0",
                "mask_idx": 4,
            }
        ],
    )
    groups = {g.prep_protocol: g for g in build_study_lineage(9, rows).groups}
    assert sorted(groups) == ["long_read_metagenomics", "short_read_amplicon"]
    long_read = groups["long_read_metagenomics"]
    assert [n.id for n in long_read.nodes] == ["run", "reads", "mask:4", "processing:12"]
    assert ("mask:4", "processing:12") in [(e.source, e.target) for e in long_read.edges]
    assert [n.id for n in groups["short_read_amplicon"].nodes] == [
        "run",
        "reads",
        "processing:11",
        "feature_table:11",
    ]


def test_reads_state_follows_the_pool_ingest_ticket_when_none_landed():
    rows = _rows(
        samples=[_sample(1, "p", read_count=None), _sample(2, "p", pool=8, read_count=None)],
        ingest=[{"sequenced_pool_idx": 7, "action_id": "bcl-convert", "state": "failed"}],
    )
    (group,) = build_study_lineage(9, rows).groups
    reads = next(n for n in group.nodes if n.id == "reads")
    assert reads.counts == {"failed": 1, "not_started": 1}


def test_an_ena_download_ticket_names_the_reads_and_gives_their_state():
    rows = _rows(
        samples=[_sample(1, "p", read_count=None), _sample(2, "p", read_count=None)],
        ingest=[
            {"sequenced_pool_idx": 7, "action_id": "download-ena-study", "state": "processing"}
        ],
    )
    (group,) = build_study_lineage(9, rows).groups
    reads = next(n for n in group.nodes if n.id == "reads")
    assert reads.detail == "download-ena-study"
    assert reads.counts == {"processing": 2}


def _profile(idx, state, genome_count=None, processing_idx=21, database=("wol3", "rc4-ani95")):
    return {
        "processing_idx": processing_idx,
        "prep_sample_idx": idx,
        "state": state,
        "genome_count": genome_count,
        "workflow": "taxonomic-profile",
        "version": "1.0.0",
        "database_name": database[0],
        "database_version": database[1],
    }


def test_each_profiling_run_is_its_own_branch_to_a_feature_table():
    rows = _rows(
        samples=[_sample(1, "short_read_metagenomics"), _sample(2, "short_read_metagenomics")],
        profiles=[
            _profile(1, "completed", 40),
            _profile(2, "no_data"),
            _profile(1, "completed", 12, processing_idx=22, database=("wol3", "rc4-ani99")),
        ],
    )
    (group,) = build_study_lineage(9, rows).groups
    nodes = {n.id: n for n in group.nodes}
    assert nodes["processing:21"].label == "Taxonomic profile"
    assert nodes["processing:21"].detail == "taxonomic-profile 1.0.0 · wol3 rc4-ani95"
    assert nodes["processing:22"].detail == "taxonomic-profile 1.0.0 · wol3 rc4-ani99"
    assert nodes["processing:21"].counts == {"completed": 1, "no_data": 1}
    assert nodes["processing:22"].counts == {"completed": 1, "not_started": 1}
    assert nodes["feature_table:21"].counts == {"completed": 1}
    edges = {(e.source, e.target) for e in group.edges}
    assert {
        ("reads", "processing:21"),
        ("processing:21", "feature_table:21"),
        ("reads", "processing:22"),
        ("processing:22", "feature_table:22"),
    } <= edges
    cells = {smp.prep_sample_idx: smp.cells for smp in group.samples}
    assert cells[1]["processing:22"].value == 12


def test_a_run_with_nothing_completed_has_no_feature_table_yet():
    rows = _rows(
        samples=[_sample(1, "short_read_amplicon"), _sample(2, "short_read_amplicon")],
        amplicons=[_amplicon(1, "pending"), _amplicon(2, "pending")],
        profiles=[_profile(1, "pending")],
    )
    (group,) = build_study_lineage(9, rows).groups
    ids = {n.id for n in group.nodes}
    assert {"processing:11", "processing:21"} <= ids
    assert not any(i.startswith("feature_table:") for i in ids)
    assert not any(e.target.startswith("feature_table:") for e in group.edges)


def test_a_sample_with_no_accession_and_no_qb_is_refused():
    rows = _rows(samples=[{**_sample(1, "short_read_amplicon"), "label": None}])
    with pytest.raises(RuntimeError, match="no accession and no QB"):
        build_study_lineage(9, rows)
