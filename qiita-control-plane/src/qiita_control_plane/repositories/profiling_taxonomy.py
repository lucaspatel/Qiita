"""A profiling database's taxonomy, `qiita.profiling_taxonomy`: each genome's
lineage, loaded from the release's registered `sylph_taxonomy` file."""

from __future__ import annotations

import asyncpg


def profiling_genome_key(name: str) -> str:
    """The key a genome is filed under: its file basename. A sylph database names
    a genome by the path it was sketched from (`.../G000802255.fna.gz`) and its
    taxonomy file by the file name, so both reduce to the basename."""
    return name.rstrip("/").rsplit("/", 1)[-1]


async def fetch_lineages(
    pool: asyncpg.Pool | asyncpg.Connection, *, reference_idx: int, genomes: list[str]
) -> dict[str, str]:
    """Genome name (as given) -> lineage, for those of `genomes` the release's
    taxonomy names. A genome it does not name is absent, not an error: a database
    and its taxonomy file can disagree at the edges, and the feature still has its
    name."""
    keys = {g: profiling_genome_key(g) for g in genomes}
    rows = await pool.fetch(
        "SELECT genome, lineage FROM qiita.profiling_taxonomy"
        " WHERE reference_idx = $1 AND genome = ANY($2::text[])",
        reference_idx,
        sorted(set(keys.values())),
    )
    by_key = {r["genome"]: r["lineage"] for r in rows}
    return {g: by_key[k] for g, k in keys.items() if k in by_key}
