#!/usr/bin/env python3
"""Load a delivered metadata sheet into a study over REST alone (no database access).

For a deploy where only the API is reachable. Rows are matched to the study's
existing biosamples by matrix tube, then by owner sample id; matched biosamples get
their metadata patched, and the rest are created through the bulk import. Safe to
re-run: a second run matches every row it created.

What it cannot do over REST, it reports instead of working around:
  * look up a terminology term: values that are labels need `--term-map`;
  * rename an owner sample id (a tube-registered biosample keeps its tube number);
  * add a terminology term the deployment lacks (a value no term matches is
    skipped on a patched biosample, and a new row whose required value fails is
    not created; both are listed at the end);
  * load a tube two rows claim (neither row gets it).

Usage:
  python3 scripts/dev/load-study-metadata.py --api http://localhost:18080/api/v1 \\
      --token-file ~/.qiita/tokens/dev --study 25060 --sheet 15663.txt \\
      --term-map scripts/dev/15663-term-map.json [--dry-run]
"""

import argparse
import csv
import json
import re
import sys
import urllib.error
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ALIAS_FILE = (
    Path(__file__).resolve().parents[2] / "qiita-web/src/lib/globalFieldAliases.ts"
)
# Sheet columns written straight to the global field of the same name.
GLOBAL_COLUMNS = {"collection_date", "qiita_sample_type", "taxon_id"}
TUBE_COLUMN = "tube_id"
ID_COLUMN = "sample_name"
# The bulk import caps a request's metadata values; 250 rows of ~60 stays under it.
CHUNK = 250


class Api:
    def __init__(self, base: str, token: str):
        self.base, self.token = base.rstrip("/"), token

    def call(self, method: str, path: str, body=None):
        req = urllib.request.Request(
            self.base + path,
            method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.status, json.loads(r.read() or "null")
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                return e.code, json.loads(raw or "null")
            except json.JSONDecodeError:
                return e.code, raw.decode(errors="replace")

    def ok(self, method: str, path: str, body=None):
        status, data = self.call(method, path, body)
        if status >= 300:
            sys.exit(f"{method} {path}: HTTP {status} {data}")
        return data


def tube(value: str) -> str | None:
    v = value.strip()
    return v.zfill(10) if re.fullmatch(r"\d{9,10}", v) else None


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument(
        "--api",
        required=True,
        help="control plane API base, e.g. http://localhost:18080/api/v1",
    )
    ap.add_argument("--token-file", required=True, type=Path)
    ap.add_argument(
        "--term-map",
        type=Path,
        help="JSON {column: {label: term_id}}: terminology values arrive as term ids,"
        " and no route lists a deployment's terms",
    )
    ap.add_argument("--study", required=True, type=int)
    ap.add_argument(
        "--sheet", required=True, type=Path, help="tab-separated metadata sheet"
    )
    ap.add_argument(
        "--dry-run", action="store_true", help="report the plan; write nothing"
    )
    args = ap.parse_args()
    api = Api(args.api, args.token_file.expanduser().read_text().strip())
    s = args.study

    rows = list(csv.DictReader(args.sheet.open(encoding="utf-8-sig"), delimiter="\t"))
    headers = list(rows[0])
    for col in (ID_COLUMN, TUBE_COLUMN):
        if col not in headers:
            sys.exit(f"the sheet has no {col!r} column")
    term_map = json.loads(args.term_map.read_text()) if args.term_map else {}
    aliases = dict(
        re.findall(r"^\s+(\w+): '(\w+)',?\s*$", ALIAS_FILE.read_text(), re.MULTILINE)
    )

    # The study's fields: its owner-id field (the unique text one), and which exist.
    fields = api.ok("GET", f"/study/{s}/biosample-field")
    id_fields = [
        f["display_name"]
        for f in fields
        if f["unique_in_study"] and f["data_type"] == "text"
    ]
    if len(id_fields) != 1:
        sys.exit(f"expected one unique text field to hold owner ids, found {id_fields}")
    id_field = id_fields[0]
    have = {f["display_name"] for f in fields}
    globals_ = {g["internal_name"]: g for g in api.ok("GET", "/biosample-global-field")}
    required = {name for name, g in globals_.items() if g["required"]}

    # Existing biosamples: tube and owner id of each.
    idxs = api.ok("GET", f"/study/{s}/biosample/list-idxs")["idxs"]
    with ThreadPoolExecutor(8) as pool:
        records = list(
            pool.map(lambda i: api.ok("GET", f"/study/{s}/biosample/{i}"), idxs)
        )
    by_tube = {
        r["matrix_tube_id"]: r["biosample_idx"] for r in records if r["matrix_tube_id"]
    }
    by_name = {
        r["local_metadata"][id_field]["value"]: r["biosample_idx"]
        for r in records
        if id_field in r.get("local_metadata", {})
    }

    tube_rows = Counter(t for r in rows if (t := tube(r[TUBE_COLUMN])))
    contested = {t for t, n in tube_rows.items() if n > 1}
    matched, new = [], []
    for r in rows:
        t = tube(r[TUBE_COLUMN])
        hit = (by_tube.get(t) if t and t not in contested else None) or by_name.get(
            r[ID_COLUMN]
        )
        (matched if hit else new).append((r, hit))
    seen = Counter(h for _, h in matched)
    if dup := [h for h, n in seen.items() if n > 1]:
        sys.exit(f"several rows matched one biosample: {dup[:5]}")
    renamed = sum(1 for r, h in matched if by_name.get(r[ID_COLUMN]) != h)

    local = [
        h
        for h in headers
        if h not in (ID_COLUMN, TUBE_COLUMN, id_field)
        and h not in GLOBAL_COLUMNS
        and h not in aliases
        and h not in have
    ]
    alias_new = {h: g for h, g in aliases.items() if h in headers and h not in have}

    print(f"study {s}: {len(records)} biosamples; owner ids in {id_field!r}")
    print(
        f"sheet: {len(rows)} rows -> {len(matched)} match an existing biosample, {len(new)} to create"
    )
    print(
        f"  {renamed} matched by tube keep their registered owner id (REST cannot rename one)"
    )
    for t in sorted(contested):
        print(f"  tube {t} is claimed by {tube_rows[t]} rows; none of them gets it")
    print(
        f"fields to create: {len(local)} study-local, {len(alias_new)} linked to globals {sorted(alias_new)}"
    )
    if args.dry_run:
        return

    for h in local:
        api.ok(
            "POST",
            f"/study/{s}/biosample-field",
            {"display_name": h, "data_type": "text"},
        )
    for h, g in alias_new.items():
        api.ok(
            "POST",
            f"/study/{s}/biosample-field",
            {
                "display_name": h,
                "biosample_global_field_idx": globals_[g]["biosample_global_field_idx"],
            },
        )

    def metadata(r: dict) -> dict:
        out = {}
        for k, v in r.items():
            v = (v or "").strip()
            if k in (ID_COLUMN, TUBE_COLUMN, id_field) or not v:
                continue
            out[k] = term_map.get(k, {}).get(v, v)
        # The standard's host_taxon_id is the sheet's host_taxid; a control's
        # "control sample" there is not a taxon.
        if "host_taxid" in out:
            out["host_taxon_id"] = (
                out["host_taxid"] if out["host_taxid"].isdigit() else "not applicable"
            )
        return out

    # Values a field refuses (a terminology term this deployment lacks, most often),
    # learned as they come up so each is tried once.
    refused: dict[tuple[str, str], str] = {}
    accepted: set[tuple[str, str]] = set()

    def patch(idx: int, md: dict) -> None:
        md = {k: v for k, v in md.items() if (k, v) not in refused}
        status, body = api.call(
            "PATCH",
            f"/study/{s}/biosample/{idx}/metadata",
            {"metadata": md, "global_internal_names": True},
        )
        if status < 300:
            accepted.update(md.items())
            return
        if status != 422:
            sys.exit(f"patch biosample {idx}: HTTP {status} {body}")
        # Find the refused values one field at a time; the rest go in one call.
        good = {}
        for k, v in md.items():
            if (k, v) in accepted:
                good[k] = v
                continue
            st, b = api.call(
                "PATCH",
                f"/study/{s}/biosample/{idx}/metadata",
                {"metadata": {k: v}, "global_internal_names": True},
            )
            if st < 300:
                accepted.add((k, v))
            elif st == 422:
                refused[(k, v)] = str(b.get("detail") if isinstance(b, dict) else b)[
                    :200
                ]
            else:
                sys.exit(f"patch biosample {idx} {k}: HTTP {st} {b}")
        if good:
            api.ok(
                "PATCH",
                f"/study/{s}/biosample/{idx}/metadata",
                {"metadata": good, "global_internal_names": True},
            )

    for n, (r, idx) in enumerate(matched, 1):
        patch(idx, metadata(r))
        if n % 50 == 0:
            print(f"patched {n}/{len(matched)}")
    print(f"patched {len(matched)} existing biosamples")

    owner = api.ok("GET", f"/study/{s}")["owner_idx"]
    not_created = []
    queue = [r for r, _ in new]
    for start in range(0, len(queue), CHUNK):
        batch = queue[start : start + CHUNK]
        while batch:
            body = {
                "rows": [
                    {
                        "owner_idx": owner,
                        "owner_biosample_id_field_name": id_field,
                        "owner_biosample_id_value": r[ID_COLUMN],
                        # Required global fields only; the rest is patched after, so
                        # one refused value costs a field, not a biosample.
                        "metadata": {
                            k: v
                            for k, v in metadata(r).items()
                            if (k in required or aliases.get(k) in required)
                            and (k, v) not in refused
                        },
                        "global_internal_names": True,
                        "matrix_tube_id": t
                        if (t := tube(r[TUBE_COLUMN])) and t not in contested
                        else None,
                    }
                    for r in batch
                ]
            }
            status, resp = api.call("POST", f"/study/{s}/biosample/bulk", body)
            if status < 300:
                for r, res in zip(batch, resp["results"], strict=True):
                    patch(res["biosample_idx"], metadata(r))
                print(f"created {start + len(batch)}/{len(queue)}")
                break
            detail = str(resp.get("detail") if isinstance(resp, dict) else resp)
            m = re.match(r"row (\d+) \(counting from 0", detail)
            if status not in (409, 422) or not m:
                sys.exit(f"bulk import: HTTP {status} {detail}")
            bad = batch.pop(int(m.group(1)))
            not_created.append((bad[ID_COLUMN], detail))

    print(
        "\nvalues the deployment refused (left out):"
        if refused
        else "\nno values refused"
    )
    for (k, v), why in sorted(refused.items()):
        print(f"  {k} = {v!r}: {why}")
    if not_created:
        print(f"\n{len(not_created)} rows not created:")
        for name, why in not_created:
            print(f"  {name}: {why[:240]}")


if __name__ == "__main__":
    main()
