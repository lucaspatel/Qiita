"""Build the Parquet the feature table's `greengenes2` filter joins against.

Reads a Greengenes2 release's md5-keyed taxonomy (`<release>.taxonomy.md5.tsv.gz`,
columns `Feature ID`, `Taxon`, `Confidence`), keeps the rows whose id is an ASV's
md5 (the rest are backbone records named by accession), and writes `(md5, lineage)`
sorted by md5, which is what `GREENGENES2_ASV_TAXONOMY_PATH` names. What the filter
does with it is in `qiita_control_plane/greengenes2.py`.

  python greengenes2-asv-taxonomy.py \\
      --taxonomy 2024.09.taxonomy.md5.tsv.gz --out greengenes2-2024.09-asv.parquet

Run with the qiita CLI's Python (it has duckdb). 2024.09 holds about 23.1M ASVs.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import duckdb


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument(
        "--taxonomy", type=Path, required=True, help="<release>.taxonomy.md5.tsv.gz"
    )
    p.add_argument("--out", type=Path, required=True)
    args = p.parse_args()
    if args.out.exists():
        sys.exit(f"{args.out} exists; remove it or name another")

    partial = args.out.with_name(args.out.name + ".partial")
    with duckdb.connect() as con:
        con.execute(
            "COPY ("
            '  SELECT "Feature ID" AS md5, "Taxon" AS lineage'
            "  FROM read_csv(?, delim = '\\t', header = true, all_varchar = true)"
            "  WHERE regexp_full_match(\"Feature ID\", '[0-9a-f]{32}')"
            "  ORDER BY md5"
            f") TO '{partial}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 122880)",
            [str(args.taxonomy)],
        )
        rows, distinct = con.execute(
            "SELECT count(*), count(DISTINCT md5) FROM read_parquet(?)", [str(partial)]
        ).fetchone()
    if rows != distinct:
        partial.unlink()
        sys.exit(f"{rows - distinct} md5(s) appear twice in {args.taxonomy}")
    if rows == 0:
        partial.unlink()
        sys.exit(f"no md5-keyed rows in {args.taxonomy}")
    partial.rename(args.out)
    print(f"wrote {rows} ASVs to {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
