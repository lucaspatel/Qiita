"""The taxonomic-profile completion gate, `qiita.taxonomic_profile_sample`.

One row per (processing_idx, prep_sample): 'pending' for the pool's metagenomic
samples when the runner mints the run identity, then 'completed' (with how many
genomes the profiler reported) or 'no_data' when the run's terminal
`finalize-taxonomic-profile-sample` action closes it. The twin of
`repositories.amplicon`'s gate.
"""

from __future__ import annotations

import asyncpg
from qiita_common.taxonomic_profile_constants import METAGENOMIC_PREP_PROTOCOLS

from . import require_transaction

TAXONOMIC_PROFILE_SAMPLE_PENDING = "pending"
TAXONOMIC_PROFILE_SAMPLE_COMPLETED = "completed"
TAXONOMIC_PROFILE_SAMPLE_NO_DATA = "no_data"


async def list_pool_metagenomic_prep_sample_idxs(
    conn: asyncpg.Connection | asyncpg.Pool, pool_idx: int
) -> list[int]:
    """The pool's live metagenomic prep_samples, ascending: what a profiling run of
    the pool covers. An ENA study's runs share one pool whatever their library, so
    its amplicon samples are left out here rather than refused."""
    rows = await conn.fetch(
        "SELECT ps.idx FROM qiita.sequenced_sample ss"
        "  JOIN qiita.prep_sample ps ON ps.idx = ss.prep_sample_idx"
        "  JOIN qiita.prep_protocol pp ON pp.idx = ps.prep_protocol_idx"
        " WHERE ss.sequenced_pool_idx = $1 AND ps.retired IS NOT TRUE"
        "   AND ss.ena_status IS NULL AND pp.name = ANY($2::text[])"
        " ORDER BY ps.idx",
        pool_idx,
        list(METAGENOMIC_PREP_PROTOCOLS),
    )
    return [r["idx"] for r in rows]


async def create_taxonomic_profile_samples_pending(
    conn: asyncpg.Connection, *, processing_idx: int, prep_sample_idxs: list[int]
) -> None:
    """Materialize the run's gate rows at 'pending' for `prep_sample_idxs`.

    Idempotent, with the amplicon gate's asymmetry: a row a previous run of the
    same identity left 'no_data' reopens, one it left 'completed' stays (that
    run's profile is in the lake)."""
    require_transaction(conn)
    await conn.execute(
        "INSERT INTO qiita.taxonomic_profile_sample (processing_idx, prep_sample_idx, state)"
        " SELECT $1, unnest($2::bigint[]), $3"
        " ON CONFLICT (processing_idx, prep_sample_idx) DO UPDATE SET state = $3"
        "   WHERE qiita.taxonomic_profile_sample.state = $4",
        processing_idx,
        prep_sample_idxs,
        TAXONOMIC_PROFILE_SAMPLE_PENDING,
        TAXONOMIC_PROFILE_SAMPLE_NO_DATA,
    )


async def close_taxonomic_profile_samples(
    conn: asyncpg.Connection, *, processing_idx: int, genome_counts: dict[int, int]
) -> tuple[int, int]:
    """Close the run's gate: 'completed' with its count for every sample in
    `genome_counts` (prep_sample_idx -> genomes reported, each > 0), 'no_data' for
    every other row of the run still 'pending'. Returns (completed, no_data)."""
    require_transaction(conn)
    if any(n <= 0 for n in genome_counts.values()):
        raise ValueError("genome_counts must name only samples with at least one genome")
    completed = await conn.fetchval(
        "WITH written AS ("
        "  INSERT INTO qiita.taxonomic_profile_sample"
        "    (processing_idx, prep_sample_idx, state, genome_count)"
        "  SELECT $1, c.prep_sample_idx, $4, c.genome_count"
        "    FROM unnest($2::bigint[], $3::int[]) AS c(prep_sample_idx, genome_count)"
        "  ON CONFLICT (processing_idx, prep_sample_idx)"
        "    DO UPDATE SET state = $4, genome_count = EXCLUDED.genome_count"
        "  RETURNING 1"
        ") SELECT count(*) FROM written",
        processing_idx,
        list(genome_counts),
        list(genome_counts.values()),
        TAXONOMIC_PROFILE_SAMPLE_COMPLETED,
    )
    no_data = await conn.fetchval(
        "WITH written AS ("
        "  UPDATE qiita.taxonomic_profile_sample SET state = $3"
        "   WHERE processing_idx = $1 AND state = $2"
        "     AND prep_sample_idx <> ALL($4::bigint[])"
        "  RETURNING 1"
        ") SELECT count(*) FROM written",
        processing_idx,
        TAXONOMIC_PROFILE_SAMPLE_PENDING,
        TAXONOMIC_PROFILE_SAMPLE_NO_DATA,
        list(genome_counts),
    )
    return completed, no_data
