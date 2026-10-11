"""Deployment identity route.

GET /deployment reports which deployment this control plane is ("prod",
"dev"), so the CLI and the web UI can show the server's own answer to "where
am I acting?" instead of trusting a label configured on the client.
Unauthenticated: it is asked before a token is chosen, and the name is not a
secret.
"""

from fastapi import APIRouter, Depends
from qiita_common.api_paths import PATH_DEPLOYMENT_PREFIX, PATH_DEPLOYMENT_ROOT
from qiita_common.models import DeploymentResponse

from ..config import Settings
from ..deps import get_settings

router = APIRouter(prefix=PATH_DEPLOYMENT_PREFIX, tags=["deployment"])


@router.get(PATH_DEPLOYMENT_ROOT)
async def get_deployment(settings: Settings = Depends(get_settings)) -> DeploymentResponse:
    """The operator-set deployment name, or null for an unnamed deploy."""
    return DeploymentResponse(name=settings.deployment_name)
