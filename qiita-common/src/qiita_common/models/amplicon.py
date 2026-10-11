"""The amplicon feature table: one cohort request, and the samples it names."""

from typing import Annotated, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from qiita_common.amplicon_constants import MAX_AMPLICON_RUNS

PositiveIdx = Annotated[int, Field(gt=0)]


class AmpliconFeatureTableRequest(BaseModel):
    """Which amplicon runs, over which samples: a study's, or a named list.

    The runs merge into one table only when their ASVs are comparable; the route
    refuses runs that differ in trim length or orientation.
    """

    model_config = ConfigDict(extra="forbid")

    processing_idx: Annotated[list[PositiveIdx], Field(min_length=1, max_length=MAX_AMPLICON_RUNS)]
    study_idx: PositiveIdx | None = None
    prep_sample_idx: Annotated[list[PositiveIdx], Field(min_length=1)] | None = None

    @model_validator(mode="after")
    def _one_cohort(self) -> Self:
        if (self.study_idx is None) == (self.prep_sample_idx is None):
            raise ValueError("name the samples by exactly one of study_idx or prep_sample_idx")
        return self


class AmpliconFeatureTableSample(BaseModel):
    """One column of the table: a processed sample (one run's view of one
    prep_sample), under its public name."""

    model_config = ConfigDict(extra="forbid")

    # The column name the counts use: the biosample's deposited accession
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


class AmpliconFeatureTableSamples(BaseModel):
    model_config = ConfigDict(extra="forbid")

    samples: list[AmpliconFeatureTableSample]
