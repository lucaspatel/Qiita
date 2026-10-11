"""`GET /study/{study_idx}/lineage` — every sample's provenance in the study,
grouped into one DAG per prep protocol (`lineage.py` builds it).

Same access contract as the study's sequenced-sample and pool listings, whose
population it shares: a human with `study:read` and viewer tier or higher on the
study (wet_lab_admin and up bypass the tier), 404 on a study that does not exist.
"""

from typing import Annotated

import asyncpg
from fastapi import APIRouter, Depends
from pydantic import Field
from qiita_common.api_paths import PATH_STUDY_LINEAGE, PATH_STUDY_PREFIX
from qiita_common.auth_constants import Scope, SystemRole
from qiita_common.models.lineage import StudyLineageResponse
from qiita_common.models.reference import Tier

from ..auth.guards import require_human, require_scope, require_study_access, require_study_exists
from ..auth.principal import HumanUser, Principal
from ..deps import get_db_pool
from ..lineage import build_study_lineage, fetch_study_lineage

router = APIRouter(prefix=PATH_STUDY_PREFIX, tags=["study"])


@router.get(PATH_STUDY_LINEAGE)
async def get_study_lineage(
    study_idx: Annotated[int, Field(gt=0)],
    pool: asyncpg.Pool = Depends(get_db_pool),
    _user: HumanUser = Depends(require_human),
    _scope: Principal = Depends(require_scope(Scope.STUDY_READ)),
    _exists: None = Depends(require_study_exists),
    _access: None = Depends(
        require_study_access(min_tier=Tier.VIEWER, bypass_role=SystemRole.WET_LAB_ADMIN)
    ),
) -> StudyLineageResponse:
    """The study's lineage: per prep protocol, the stages its samples reached, the
    edges between them, and each sample's state at each."""
    return build_study_lineage(study_idx, await fetch_study_lineage(pool, study_idx))
