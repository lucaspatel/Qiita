"""The study lineage: every sample's provenance, grouped into one DAG per prep
protocol, ready for a client to lay out (`GET /study/{study_idx}/lineage`)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict

# A sample's state at one node. 'not_started' is a sample of the group the node
# has no record for; the rest are the gate / ticket states they come from.
LineageState = Literal[
    "completed", "no_data", "pending", "processing", "failed", "invalidated", "not_started"
]

LineageNodeKind = Literal["run", "reads", "mask", "processing", "product"]


class LineageNode(BaseModel):
    """One stage (or product) of a group's DAG, with how many of the group's
    samples are in each state there. A stage counts every sample of the group
    ('not_started' where it has no record); a product counts only the samples it
    contains."""

    model_config = ConfigDict(extra="forbid")

    id: str
    kind: LineageNodeKind
    # What the node is ("Reads", "ASVs"); `detail` says what produced it
    # ("golay-demux", "amplicon 1.1.0").
    label: str
    detail: str | None = None
    # The workflow a processing node ran; absent on run, reads and product nodes.
    action_id: str | None = None
    processing_idx: int | None = None
    mask_idx: int | None = None
    counts: dict[LineageState, int]
    # What a sample's `value` at this node measures (e.g. "ASVs"); None if nothing.
    value_label: str | None = None


class LineageEdge(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source: str
    target: str


class LineageCell(BaseModel):
    """One sample at one node."""

    model_config = ConfigDict(extra="forbid")

    state: LineageState
    value: int | None = None


class LineageSample(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prep_sample_idx: int
    # The biosample's accession where it has one, else the pool item id.
    label: str
    sequencing_run_idx: int | None
    sequenced_pool_idx: int | None
    # node id -> the sample's state there; a node absent here is 'not_started'.
    cells: dict[str, LineageCell]


class LineageGroup(BaseModel):
    """The DAG of one prep protocol's samples."""

    model_config = ConfigDict(extra="forbid")

    prep_protocol: str
    nodes: list[LineageNode]
    edges: list[LineageEdge]
    samples: list[LineageSample]


class StudyLineageResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    study_idx: int
    groups: list[LineageGroup]
