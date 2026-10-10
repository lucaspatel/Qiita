"""Classification rules for resolving a pool roster by tube or accession.

Pure: the facts the database would supply are handed in, so every rule is
exercised without Postgres. The route over these rules is covered by the
db-tier tests in tests/routes/test_biosample_resolve_roster.py.
"""

from qiita_common.models import RosterProblemCode, RosterResolvedRow, RosterResolveRow

from qiita_control_plane.roster_resolution import RosterFacts, classify_roster

TUBE = "0363157924"
TUBE_RAW = "363157924"


def _facts(**overrides) -> RosterFacts:
    base = {
        "by_tube": {TUBE: (11, None)},
        "by_biosample_accession": {"SAMN1": 21},
        "by_study_accession": {"PRJNA1": 101, "PRJNA2": 102},
        "study_links": {11: [101], 21: [101]},
    }
    base.update(overrides)
    return RosterFacts(**base)


def _codes(problems) -> list[tuple[str, str]]:
    return [(p.item_id, p.code) for p in problems]


def test_tube_row_resolves_study_from_its_link():
    resolved, problems = classify_roster(
        [RosterResolveRow(item_id="1", matrix_tube_id=TUBE_RAW)], _facts()
    )
    assert problems == []
    assert resolved == [
        RosterResolvedRow(
            item_id="1", biosample_idx=11, primary_study_idx=101, secondary_study_idxs=[]
        )
    ]


def test_tube_row_project_accession_must_name_a_linked_study():
    ok, ok_problems = classify_roster(
        [RosterResolveRow(item_id="1", matrix_tube_id=TUBE, primary_project_accession="PRJNA1")],
        _facts(),
    )
    assert ok_problems == []
    assert ok[0].primary_study_idx == 101

    _, problems = classify_roster(
        [RosterResolveRow(item_id="1", matrix_tube_id=TUBE, primary_project_accession="PRJNA2")],
        _facts(),
    )
    assert _codes(problems) == [("1", RosterProblemCode.STUDY_MISMATCH)]


def test_tube_row_with_no_or_several_study_links():
    _, none = classify_roster(
        [RosterResolveRow(item_id="1", matrix_tube_id=TUBE)], _facts(study_links={})
    )
    assert _codes(none) == [("1", RosterProblemCode.NO_STUDY)]
    _, several = classify_roster(
        [RosterResolveRow(item_id="1", matrix_tube_id=TUBE)],
        _facts(study_links={11: [101, 102]}),
    )
    assert _codes(several) == [("1", RosterProblemCode.AMBIGUOUS_STUDY)]


def test_tube_problems_malformed_unknown_duplicate():
    rows = [
        RosterResolveRow(item_id="bad", matrix_tube_id="800805.001.V1.Plasma"),
        RosterResolveRow(item_id="gone", matrix_tube_id="999"),
        RosterResolveRow(item_id="a", matrix_tube_id=TUBE_RAW),
        RosterResolveRow(item_id="b", matrix_tube_id=TUBE),
    ]
    resolved, problems = classify_roster(rows, _facts())
    assert resolved == []
    assert _codes(problems) == [
        ("bad", RosterProblemCode.MALFORMED_TUBE),
        ("gone", RosterProblemCode.UNKNOWN_TUBE),
        ("a", RosterProblemCode.DUPLICATE_TUBE),
        ("b", RosterProblemCode.DUPLICATE_TUBE),
    ]
    by_item = {p.item_id: p for p in problems}
    assert by_item["bad"].value == "800805.001.V1.Plasma"
    # The value reported is the normalized tube, the one a registry holds.
    assert by_item["gone"].value == "0000000999"


def test_tube_and_accession_must_agree():
    _, problems = classify_roster(
        [RosterResolveRow(item_id="1", matrix_tube_id=TUBE, biosample_accession="SAMN9")],
        _facts(by_tube={TUBE: (11, "SAMN1")}),
    )
    assert _codes(problems) == [("1", RosterProblemCode.IDENTITY_CONFLICT)]


def test_accession_row_keeps_todays_resolution():
    resolved, problems = classify_roster(
        [
            RosterResolveRow(
                item_id="1",
                biosample_accession="SAMN1",
                primary_project_accession="PRJNA1",
                secondary_project_accessions=["PRJNA2"],
            )
        ],
        _facts(),
    )
    assert problems == []
    assert resolved == [
        RosterResolvedRow(
            item_id="1", biosample_idx=21, primary_study_idx=101, secondary_study_idxs=[102]
        )
    ]


def test_accession_and_identity_problems():
    rows = [
        RosterResolveRow(item_id="none"),
        RosterResolveRow(
            item_id="nobs", biosample_accession="SAMN404", primary_project_accession="PRJNA1"
        ),
        RosterResolveRow(
            item_id="nostudy",
            biosample_accession="SAMN1",
            primary_project_accession="PRJNA404",
            secondary_project_accessions=["PRJNA405"],
        ),
    ]
    _, problems = classify_roster(rows, _facts())
    assert _codes(problems) == [
        ("none", RosterProblemCode.NO_IDENTITY),
        ("nobs", RosterProblemCode.UNKNOWN_BIOSAMPLE_ACCESSION),
        ("nostudy", RosterProblemCode.UNKNOWN_STUDY_ACCESSION),
        ("nostudy", RosterProblemCode.UNKNOWN_STUDY_ACCESSION),
    ]


def test_mixed_roster_resolves_in_request_order():
    rows = [
        RosterResolveRow(item_id="t", matrix_tube_id=TUBE),
        RosterResolveRow(
            item_id="a", biosample_accession="SAMN1", primary_project_accession="PRJNA1"
        ),
    ]
    resolved, problems = classify_roster(rows, _facts())
    assert problems == []
    assert [r.item_id for r in resolved] == ["t", "a"]
