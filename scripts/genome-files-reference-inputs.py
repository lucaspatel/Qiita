"""Build `qiita reference load --local` inputs from per-genome FASTA files.

Every contig in a genome's file belongs to that genome, but the loader keys genomes
and taxonomy by contig (`read_id`, a header's first token), so this writes the
per-contig inputs into --out:

  fasta_manifest.txt  one absolute FASTA path per line          (--fasta-manifest)
  genome_map.parquet  (read_id, genome_source, genome_source_id) (--genome-map)
  taxonomy.parquet    (feature_id, taxonomy), each contig carrying its genome's
                      lineage                                     (--taxonomy)

A genome's id is its file name reduced by the rule a sylph profile's genome names
are (`qiita_common.taxonomic_profile_constants`), so a sylph database sketched from
these files reports these genomes: `G000802255.fna.gz` is `G000802255`,
`GCA_000005845.2_genomic.fna.gz` is `GCA_000005845.2`. `GCF_` ids are refseq and
every other id genbank, which is how production holds WoL's `G` ids.

The taxonomy TSV is `<genome>\\t<lineage>` (`d__...;s__...`), a header line allowed;
the genome may be an id, a file name, or GTDB's `RS_`/`GB_`-prefixed accession.
Run with the qiita CLI's Python, which has qiita_common and pyarrow:

  python genome-files-reference-inputs.py --files genomes.txt \\
      --taxonomy taxonomy.tsv --out /scratch/.../inputs [--limit 200] [--jobs 32]
"""

from __future__ import annotations

import argparse
import gzip
import re
import sys
from multiprocessing import Pool
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
from qiita_common.taxonomic_profile_constants import GENOME_FILE_SUFFIX_PATTERN

_SUFFIX = re.compile(GENOME_FILE_SUFFIX_PATTERN)
_GTDB_PREFIX = re.compile(r"^(RS_|GB_)")


def genome_id(name: str) -> str:
    return _SUFFIX.sub("", name.rstrip("/").rsplit("/", 1)[-1])


def source_of(gid: str) -> str:
    return "refseq" if gid.startswith("GCF_") else "genbank"


def headers(path: str) -> tuple[str, list[str]]:
    opener = gzip.open if path.endswith(".gz") else open
    ids = []
    with opener(path, "rt") as fh:
        for line in fh:
            if line.startswith(">"):
                ids.append(line[1:].split(None, 1)[0])
    return path, ids


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument(
        "--files", type=Path, required=True, help="text file, one FASTA path per line"
    )
    p.add_argument("--taxonomy", type=Path, help="<genome>\\t<lineage> TSV")
    p.add_argument("--out", type=Path, required=True)
    p.add_argument(
        "--limit", type=int, help="only the first N genomes, for a trial load"
    )
    p.add_argument("--jobs", type=int, default=16)
    args = p.parse_args()

    paths = [
        str(Path(line.strip()).resolve())
        for line in args.files.read_text().splitlines()
        if line.strip() and not line.startswith("#")
    ][: args.limit]
    by_genome: dict[str, str] = {}
    for path in paths:
        gid = genome_id(path)
        if gid in by_genome:
            sys.exit(f"two files are genome {gid}: {by_genome[gid]} and {path}")
        by_genome[gid] = path

    lineage: dict[str, str] = {}
    if args.taxonomy:
        for line in args.taxonomy.read_text().splitlines():
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 2 or not parts[1].startswith("d__"):
                continue  # a header, or a blank line
            lineage[genome_id(_GTDB_PREFIX.sub("", parts[0].strip()))] = parts[
                1
            ].strip()
        missing = [g for g in by_genome if g not in lineage]
        print(
            f"taxonomy: {len(by_genome) - len(missing)} of {len(by_genome)} genomes",
            file=sys.stderr,
        )
        if missing:
            print(
                f"  no lineage for {len(missing)}, e.g. {missing[:5]}", file=sys.stderr
            )

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "fasta_manifest.txt").write_text("\n".join(paths) + "\n")
    gmap = pq.ParquetWriter(
        args.out / "genome_map.parquet",
        pa.schema(
            [
                ("read_id", pa.string()),
                ("genome_source", pa.string()),
                ("genome_source_id", pa.string()),
            ]
        ),
    )
    tax = (
        pq.ParquetWriter(
            args.out / "taxonomy.parquet",
            pa.schema([("feature_id", pa.string()), ("taxonomy", pa.string())]),
        )
        if args.taxonomy
        else None
    )
    seen: dict[str, str] = {}
    contigs = 0
    with Pool(args.jobs) as pool:
        for n, (path, ids) in enumerate(
            pool.imap_unordered(headers, paths, chunksize=16), 1
        ):
            gid = genome_id(path)
            if not ids:
                sys.exit(f"{path}: no FASTA record")
            for rid in ids:
                if rid in seen:
                    sys.exit(
                        f"contig {rid} is in both {seen[rid]} and {path}; read_ids must be unique"
                    )
                seen[rid] = path
            contigs += len(ids)
            gmap.write_table(
                pa.table(
                    {
                        "read_id": ids,
                        "genome_source": [source_of(gid)] * len(ids),
                        "genome_source_id": [gid] * len(ids),
                    }
                )
            )
            if tax is not None and gid in lineage:
                tax.write_table(
                    pa.table({"feature_id": ids, "taxonomy": [lineage[gid]] * len(ids)})
                )
            if n % 1000 == 0:
                print(
                    f"{n} of {len(paths)} genomes, {contigs} contigs", file=sys.stderr
                )
    gmap.close()
    if tax is not None:
        tax.close()
    print(
        f"wrote {len(paths)} genomes, {contigs} contigs to {args.out}", file=sys.stderr
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
