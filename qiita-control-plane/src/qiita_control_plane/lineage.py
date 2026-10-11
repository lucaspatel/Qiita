"""The study lineage: every sample's provenance, one DAG per prep protocol.

`fetch_study_lineage` reads, for a study's samples, everything Postgres records
about how each got where it is — its run and pool, how many reads landed (and
the pool's ingest ticket when none did), and its state in every per-sample
completion gate (`mask_sample`, `assembly_sample`, `amplicon_sample`) — in five
queries. `build_study_lineage` turns those rows into nodes, edges and per-sample
cells, so a client only lays the graph out.

Edges are the provenance the gates already carry: reads feed a read mask; an
assembly run feeds from the mask its params name (else from reads); an amplicon
run feeds from reads and produces a feature table. A group's nodes are only the
ones some sample of that group reached.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

import asyncpg
from qiita_common.actions import (
    AMPLICON_ACTION_ID,
    BCL_CONVERT_ACTION_ID,
    DOWNLOAD_ENA_STUDY_ACTION_ID,
    GOLAY_DEMUX_ACTION_ID,
)
from qiita_common.models.lineage import (
    LineageCell,
    LineageEdge,
    LineageGroup,
    LineageNode,
    LineageSample,
    LineageState,
    StudyLineageResponse,
)

from .sample_names import BIOSAMPLE_NAME_JOIN, BIOSAMPLE_NAME_SQL

# The pool-scoped actions that land a pool's reads: the two demultiplexers, and
# the ENA download for an imported pool.
POOL_INGEST_ACTION_IDS = (
    BCL_CONVERT_ACTION_ID,
    GOLAY_DEMUX_ACTION_ID,
    DOWNLOAD_ENA_STUDY_ACTION_ID,
)

RUN_NODE = "run"
READS_NODE = "reads"

# A pool ingest ticket's state, read for a sample whose reads did not land.
# Completed means the pool landed and this sample got no reads.
_INGEST_STATE: dict[str, LineageState] = {
    "completed": "no_data",
    "no_data": "no_data",
    "failed": "failed",
    "processing": "processing",
    "queued": "pending",
    "pending": "pending",
}


def _sample_label(sample: Any) -> str:
    """The sample's public name: its biosample's BioSample accession, else its ENA
    sample accession, else its minted QB. Every biosample has a QB from the
    insert that created it, so a missing label is a broken invariant."""
    if sample["label"] is None:
        raise RuntimeError(
            f"prep_sample_idx {sample['prep_sample_idx']} has no accession and no QB"
        )
    return sample["label"]


async def fetch_study_lineage(pool: asyncpg.Pool, study_idx: int) -> dict[str, list[Any]]:
    """The rows `build_study_lineage` needs for the study's live samples: the same
    population the study's sequenced-sample listing returns (live links, live
    prep_samples, no ENA-flagged sequenced sample)."""
    samples = await pool.fetch(
        "SELECT ps.idx AS prep_sample_idx, ps.biosample_idx, pp.name AS prep_protocol,"
        "       ss.sequenced_pool_idx, sp.sequencing_run_idx, ss.sequenced_pool_item_id,"
        f"       {BIOSAMPLE_NAME_SQL} AS label,"
        "       CASE WHEN b.biosample_accession IS NOT NULL THEN 'biosample_accession'"
        "            WHEN b.ena_sample_accession IS NOT NULL THEN 'ena_sample_accession'"
        "            ELSE 'export_entity_id' END AS label_source,"
        "       sr.sequence_idx_stop - sr.sequence_idx_start + 1 AS read_count"
        "  FROM qiita.prep_sample_to_study pst"
        "  JOIN qiita.prep_sample ps ON ps.idx = pst.prep_sample_idx"
        "  JOIN qiita.prep_protocol pp ON pp.idx = ps.prep_protocol_idx"
        "  JOIN qiita.biosample b ON b.idx = ps.biosample_idx"
        f"  {BIOSAMPLE_NAME_JOIN}"
        "  LEFT JOIN qiita.sequenced_sample ss ON ss.prep_sample_idx = ps.idx"
        "  LEFT JOIN qiita.sequenced_pool sp ON sp.idx = ss.sequenced_pool_idx"
        "  LEFT JOIN qiita.sequence_range sr ON sr.prep_sample_idx = ps.idx"
        " WHERE pst.study_idx = $1 AND NOT pst.retired AND ps.retired IS NOT TRUE"
        "   AND ss.ena_status IS NULL"
        " ORDER BY ps.idx",
        study_idx,
    )
    prep_sample_idxs = [r["prep_sample_idx"] for r in samples]
    pools = sorted({r["sequenced_pool_idx"] for r in samples if r["sequenced_pool_idx"]})
    ingest = await pool.fetch(
        "SELECT DISTINCT ON (sequenced_pool_idx)"
        "       sequenced_pool_idx, action_id, state::text AS state"
        "  FROM qiita.work_ticket"
        " WHERE sequenced_pool_idx = ANY($1::bigint[]) AND action_id = ANY($2::text[])"
        " ORDER BY sequenced_pool_idx, (state = 'completed') DESC, work_ticket_idx DESC",
        pools,
        list(POOL_INGEST_ACTION_IDS),
    )
    masks = await pool.fetch(
        "SELECT mask_idx, prep_sample_idx, state FROM qiita.mask_sample"
        " WHERE prep_sample_idx = ANY($1::bigint[])",
        prep_sample_idxs,
    )
    assemblies = await pool.fetch(
        "SELECT s.processing_idx, s.prep_sample_idx, s.state, p.workflow, p.version,"
        "       (p.params->>'mask_idx')::bigint AS mask_idx"
        "  FROM qiita.assembly_sample s JOIN qiita.processing p USING (processing_idx)"
        " WHERE s.prep_sample_idx = ANY($1::bigint[])",
        prep_sample_idxs,
    )
    amplicons = await pool.fetch(
        "SELECT a.processing_idx, a.prep_sample_idx, a.state, a.asv_count,"
        "       p.workflow, p.version"
        "  FROM qiita.amplicon_sample a JOIN qiita.processing p USING (processing_idx)"
        " WHERE a.prep_sample_idx = ANY($1::bigint[])",
        prep_sample_idxs,
    )
    return {
        "samples": list(samples),
        "ingest": list(ingest),
        "masks": list(masks),
        "assemblies": list(assemblies),
        "amplicons": list(amplicons),
    }


def build_study_lineage(study_idx: int, rows: dict[str, list[Any]]) -> StudyLineageResponse:
    """Group `rows` (from `fetch_study_lineage`) into one DAG per prep protocol."""
    ingest_by_pool = {r["sequenced_pool_idx"]: r for r in rows["ingest"]}
    by_protocol: dict[str, list[Any]] = defaultdict(list)
    for s in rows["samples"]:
        by_protocol[s["prep_protocol"]].append(s)

    groups = []
    for protocol in sorted(by_protocol):
        members = by_protocol[protocol]
        idxs = {s["prep_sample_idx"] for s in members}
        nodes: dict[str, LineageNode] = {}
        edges: list[LineageEdge] = []
        cells: dict[int, dict[str, LineageCell]] = {i: {} for i in idxs}

        def node(node_id: str, **fields: Any) -> None:
            if node_id not in nodes:
                nodes[node_id] = LineageNode(id=node_id, counts={}, **fields)

        def edge(source: str, target: str) -> None:
            if not any(e.source == source and e.target == target for e in edges):
                edges.append(LineageEdge(source=source, target=target))

        node(RUN_NODE, kind="run", label="Run")
        ingest_actions = sorted(
            {
                ingest_by_pool[s["sequenced_pool_idx"]]["action_id"]
                for s in members
                if s["sequenced_pool_idx"] in ingest_by_pool
            }
        )
        node(
            READS_NODE,
            kind="reads",
            label="Reads",
            detail=" / ".join(ingest_actions) or None,
            value_label="Reads",
        )
        edge(RUN_NODE, READS_NODE)
        for s in members:
            c = cells[s["prep_sample_idx"]]
            if s["sequencing_run_idx"] is not None:
                c[RUN_NODE] = LineageCell(state="completed")
            if s["read_count"] is not None:
                # The sample's sequence_range is one contiguous id per read landed.
                c[READS_NODE] = LineageCell(state="completed", value=s["read_count"])
            elif (t := ingest_by_pool.get(s["sequenced_pool_idx"])) and t["state"] in _INGEST_STATE:
                c[READS_NODE] = LineageCell(state=_INGEST_STATE[t["state"]])

        for r in rows["masks"]:
            if r["prep_sample_idx"] not in idxs:
                continue
            node_id = f"mask:{r['mask_idx']}"
            node(
                node_id,
                kind="mask",
                label="Processed reads",
                detail=f"read mask #{r['mask_idx']}",
                mask_idx=r["mask_idx"],
            )
            edge(READS_NODE, node_id)
            cells[r["prep_sample_idx"]][node_id] = LineageCell(state=r["state"])

        for r in rows["assemblies"]:
            if r["prep_sample_idx"] not in idxs:
                continue
            node_id = f"processing:{r['processing_idx']}"
            node(
                node_id,
                kind="processing",
                label="Assembly",
                detail=f"{r['workflow']} {r['version']}",
                action_id=r["workflow"],
                processing_idx=r["processing_idx"],
            )
            mask_node = f"mask:{r['mask_idx']}"
            edge(mask_node if mask_node in nodes else READS_NODE, node_id)
            cells[r["prep_sample_idx"]][node_id] = LineageCell(state=r["state"])

        for r in rows["amplicons"]:
            if r["prep_sample_idx"] not in idxs:
                continue
            node_id = f"processing:{r['processing_idx']}"
            table_id = f"feature_table:{r['processing_idx']}"
            node(
                node_id,
                kind="processing",
                label="ASVs",
                detail=f"{r['workflow']} {r['version']}",
                action_id=AMPLICON_ACTION_ID,
                processing_idx=r["processing_idx"],
                value_label="ASVs",
            )
            node(
                table_id,
                kind="product",
                label="Feature table",
                processing_idx=r["processing_idx"],
            )
            edge(READS_NODE, node_id)
            edge(node_id, table_id)
            c = cells[r["prep_sample_idx"]]
            c[node_id] = LineageCell(state=r["state"], value=r["asv_count"])
            if r["state"] == "completed":
                c[table_id] = LineageCell(state="completed", value=r["asv_count"])

        # A stage counts every sample of the group (one it never reached is
        # 'not_started'); a product counts only the samples it contains.
        for n in nodes.values():
            counts: dict[str, int] = defaultdict(int)
            for i in idxs:
                cell = cells[i].get(n.id)
                if cell is not None:
                    counts[cell.state] += 1
                elif n.kind != "product":
                    counts["not_started"] += 1
            n.counts = dict(counts)

        groups.append(
            LineageGroup(
                prep_protocol=protocol,
                nodes=list(nodes.values()),
                edges=edges,
                samples=[
                    LineageSample(
                        prep_sample_idx=s["prep_sample_idx"],
                        biosample_idx=s["biosample_idx"],
                        label=_sample_label(s),
                        label_source=s["label_source"],
                        sequencing_run_idx=s["sequencing_run_idx"],
                        sequenced_pool_idx=s["sequenced_pool_idx"],
                        cells=cells[s["prep_sample_idx"]],
                    )
                    for s in members
                ],
            )
        )
    return StudyLineageResponse(study_idx=study_idx, groups=groups)
