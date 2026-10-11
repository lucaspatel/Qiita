"""Deployment identity model — which deployment a control plane is."""

from pydantic import BaseModel


class DeploymentResponse(BaseModel):
    """`GET /deployment` — the deployment's self-reported name.

    `name` is the operator-set slug (see `Settings.deployment_name` in the
    control plane for the accepted shape), or None when the deploy is unnamed.
    """

    name: str | None
