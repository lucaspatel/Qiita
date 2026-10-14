"""A run feature table: one cohort request over processing runs, and the samples it
names. A run is an amplicon run (ASV counts) or a taxonomic-profile run (genome
relative abundances); one table holds runs of one method whose features compare."""

from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

PositiveIdx = Annotated[int, Field(gt=0)]

# The most runs one feature-table request may merge. The data plane bounds its
# tickets the same way; the reason is at its `MAX_AMPLICON_RUNS`.
MAX_FEATURE_TABLE_RUNS = 32

# What a table's values are: reads counted per feature (amplicon ASVs), or each
# feature's share of the sample (a profiler's relative abundance, in percent).
FeatureTableValueKind = Literal["count", "relative_abundance"]


# The filters a feature-table request can name.
GREENGENES2_FILTER = "greengenes2"
FeatureFilter = Literal["greengenes2"]


class FeatureTableRequest(BaseModel):
    """Which runs, over which samples: a study's, or a named list.

    The runs merge into one table only when they are runs of one method whose
    features compare: amplicon runs of one trim length and orientation, or profiles
    against one database file with one threshold. The route refuses the rest.
    """

    model_config = ConfigDict(extra="forbid")

    processing_idx: Annotated[
        list[PositiveIdx], Field(min_length=1, max_length=MAX_FEATURE_TABLE_RUNS)
    ]
    study_idx: PositiveIdx | None = None
    prep_sample_idx: Annotated[list[PositiveIdx], Field(min_length=1)] | None = None
    # A read-time filter on an amplicon table; nothing is stored, and the
    # unfiltered table is unchanged. `greengenes2`: keep the ASVs Greengenes2
    # places, ranked by its taxonomy.
    feature_filter: FeatureFilter | None = None

    @model_validator(mode="after")
    def _one_cohort(self) -> Self:
        if (self.study_idx is None) == (self.prep_sample_idx is None):
            raise ValueError("name the samples by exactly one of study_idx or prep_sample_idx")
        return self


class FeatureTableSample(BaseModel):
    """One column of the table: a processed sample (one run's view of one
    prep_sample), under its public name."""

    model_config = ConfigDict(extra="forbid")

    # The column name the values use: the biosample's deposited accession
    # (BioSample, else ENA) when no other column of the table shares it, else the
    # processed sample's QM.
    sample: str
    # The processed sample's QM, always: the stable handle, whatever `sample` is.
    export_id: str
    # The biosample's public name as the study's sample listing shows it
    # (accession, else QB): the key for joining the column to its metadata.
    biosample: str
    # Which of the requested runs this column is from (echoed from the request).
    processing_idx: int


class FeatureTableSamples(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # The runs' method (`qiita.processing.workflow`) and what its values are.
    method: str
    value_kind: FeatureTableValueKind
    samples: list[FeatureTableSample]
