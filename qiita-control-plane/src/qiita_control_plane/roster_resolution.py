"""Resolve a pool roster to biosamples and studies, by matrix tube or accession.

A row carrying a matrix tube resolves by the tube: tubes are unique across
Qiita (`qiita.biosample.matrix_tube_id` is UNIQUE), so the tube alone names the
biosample, and its study comes from the biosample's active study links. A
project accession on such a row is a cross-check, not the key. A row without a
tube resolves by biosample and project accession, as the accession lookup
routes always have.

Every problem across the roster is collected before anything is refused, so
one response names them all. `classify_roster` holds the rules and is pure;
`fetch_roster_facts` gathers what it needs in a fixed number of queries.
"""

from collections import Counter
from dataclasses import dataclass

import asyncpg
from qiita_common.models import (
    RosterProblem,
    RosterProblemCode,
    RosterResolvedRow,
    RosterResolveRow,
    normalize_matrix_tube_id,
)

from qiita_control_plane.repositories.biosample import (
    fetch_active_study_links,
    fetch_biosample_identity_by_tube,
    fetch_biosample_idxs_by_natural_key,
)
from qiita_control_plane.repositories.study import fetch_study_idxs_by_accession


@dataclass(frozen=True)
class RosterFacts:
    """What the database knows about a roster's identifiers.

    `by_tube` maps a normalized tube to (biosample_idx, biosample_accession);
    `study_links` maps a biosample_idx to its active study_idxs, ascending.
    Only non-retired biosamples appear.
    """

    by_tube: dict[str, tuple[int, str | None]]
    by_biosample_accession: dict[str, int]
    by_study_accession: dict[str, int]
    study_links: dict[int, list[int]]


def _normalized_tube(row: RosterResolveRow) -> str | None:
    """The row's tube in stored form, or None if absent or malformed."""
    if row.matrix_tube_id is None:
        return None
    try:
        return normalize_matrix_tube_id(row.matrix_tube_id)
    except ValueError:
        return None


def classify_roster(
    rows: list[RosterResolveRow], facts: RosterFacts
) -> tuple[list[RosterResolvedRow], list[RosterProblem]]:
    """Apply the resolution rules to every row.

    Returns (resolved, problems): `resolved` in request order for the rows
    that resolved cleanly, `problems` in request order for the rest. A caller
    refuses the roster when `problems` is non-empty.
    """
    tube_counts = Counter(t for t in map(_normalized_tube, rows) if t is not None)
    resolved: list[RosterResolvedRow] = []
    problems: list[RosterProblem] = []

    for row in rows:
        row_problems: list[RosterProblem] = []

        def problem(code: RosterProblemCode, message: str, value: str | None = None) -> None:
            row_problems.append(
                RosterProblem(item_id=row.item_id, code=code, value=value, message=message)
            )

        biosample_idx: int | None = None
        by_tube = row.matrix_tube_id is not None
        if by_tube:
            tube = _normalized_tube(row)
            if tube is None:
                problem(
                    RosterProblemCode.MALFORMED_TUBE,
                    f"{row.matrix_tube_id!r} is not a matrix tube id (1 to 10 digits)",
                    row.matrix_tube_id,
                )
            elif tube_counts[tube] > 1:
                problem(
                    RosterProblemCode.DUPLICATE_TUBE,
                    f"matrix tube {tube} appears on {tube_counts[tube]} rows of this roster",
                    tube,
                )
            elif tube not in facts.by_tube:
                problem(
                    RosterProblemCode.UNKNOWN_TUBE,
                    f"no biosample has matrix tube {tube}; register it before submitting",
                    tube,
                )
            else:
                biosample_idx, registered_accession = facts.by_tube[tube]
                if (
                    row.biosample_accession is not None
                    and row.biosample_accession != registered_accession
                ):
                    problem(
                        RosterProblemCode.IDENTITY_CONFLICT,
                        f"matrix tube {tube} is biosample {biosample_idx}, whose accession is"
                        f" {registered_accession!r}, not {row.biosample_accession!r}",
                        row.biosample_accession,
                    )
                    biosample_idx = None
        elif row.biosample_accession is not None:
            biosample_idx = facts.by_biosample_accession.get(row.biosample_accession)
            if biosample_idx is None:
                problem(
                    RosterProblemCode.UNKNOWN_BIOSAMPLE_ACCESSION,
                    f"no biosample has accession {row.biosample_accession!r}",
                    row.biosample_accession,
                )
        else:
            problem(
                RosterProblemCode.NO_IDENTITY,
                "row carries neither a matrix tube nor a biosample accession",
            )

        primary_study_idx: int | None = None
        if row.primary_project_accession is not None:
            primary_study_idx = facts.by_study_accession.get(row.primary_project_accession)
            if primary_study_idx is None:
                problem(
                    RosterProblemCode.UNKNOWN_STUDY_ACCESSION,
                    f"no study has accession {row.primary_project_accession!r}",
                    row.primary_project_accession,
                )
            elif (
                by_tube
                and biosample_idx is not None
                and primary_study_idx not in facts.study_links.get(biosample_idx, [])
            ):
                problem(
                    RosterProblemCode.STUDY_MISMATCH,
                    f"biosample {biosample_idx} is not in study {primary_study_idx}"
                    f" ({row.primary_project_accession})",
                    row.primary_project_accession,
                )
                primary_study_idx = None
        elif biosample_idx is not None:
            links = facts.study_links.get(biosample_idx, [])
            if not links:
                problem(
                    RosterProblemCode.NO_STUDY,
                    f"biosample {biosample_idx} belongs to no active study",
                )
            elif len(links) > 1:
                problem(
                    RosterProblemCode.AMBIGUOUS_STUDY,
                    f"biosample {biosample_idx} belongs to studies {links}; name the"
                    " project's bioproject accession to choose one",
                )
            else:
                primary_study_idx = links[0]

        secondary_study_idxs: list[int] = []
        for accession in row.secondary_project_accessions:
            study_idx = facts.by_study_accession.get(accession)
            if study_idx is None:
                problem(
                    RosterProblemCode.UNKNOWN_STUDY_ACCESSION,
                    f"no study has accession {accession!r}",
                    accession,
                )
            else:
                secondary_study_idxs.append(study_idx)

        if row_problems:
            problems.extend(row_problems)
        elif biosample_idx is not None and primary_study_idx is not None:
            resolved.append(
                RosterResolvedRow(
                    item_id=row.item_id,
                    biosample_idx=biosample_idx,
                    primary_study_idx=primary_study_idx,
                    secondary_study_idxs=secondary_study_idxs,
                )
            )
    return resolved, problems


async def fetch_roster_facts(
    conn: asyncpg.Pool | asyncpg.Connection, rows: list[RosterResolveRow]
) -> RosterFacts:
    """Gather every fact `classify_roster` needs: one query per identifier
    kind, then one for the study links of every biosample found."""
    tubes = sorted({t for t in map(_normalized_tube, rows) if t is not None})
    biosample_accessions = sorted(
        {r.biosample_accession for r in rows if r.matrix_tube_id is None and r.biosample_accession}
    )
    study_accessions = sorted(
        {r.primary_project_accession for r in rows if r.primary_project_accession}
        | {a for r in rows for a in r.secondary_project_accessions}
    )
    by_tube = await fetch_biosample_identity_by_tube(conn, tubes)
    by_biosample_accession = await fetch_biosample_idxs_by_natural_key(
        conn, key="biosample_accession", values=biosample_accessions
    )
    by_study_accession = await fetch_study_idxs_by_accession(conn, values=study_accessions)
    biosample_idxs = sorted(
        {idx for idx, _ in by_tube.values()} | set(by_biosample_accession.values())
    )
    study_links = await fetch_active_study_links(conn, biosample_idxs)
    return RosterFacts(
        by_tube=by_tube,
        by_biosample_accession=by_biosample_accession,
        by_study_accession=by_study_accession,
        study_links=study_links,
    )
