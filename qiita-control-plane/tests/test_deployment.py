"""Tests for `GET /deployment`.

Pure unit, no DB marker — the route reads only `Settings.deployment_name`.
Same app-state save/restore shape as tests/test_landing.py.
"""

import pytest
from httpx import ASGITransport, AsyncClient
from qiita_common.api_paths import URL_DEPLOYMENT_PREFIX

from qiita_control_plane.config import Settings


def _settings(deployment_name: str | None) -> Settings:
    return Settings(
        database_url="unused",
        flight_signing_key=b"\x00" * 32,
        data_plane_url="unused",
        deployment_name=deployment_name,
    )


@pytest.fixture
def app_with():
    from qiita_control_plane.main import app as fastapi_app

    prior = getattr(fastapi_app.state, "settings", None)

    def _install(name: str | None):
        fastapi_app.state.settings = _settings(name)
        return fastapi_app

    try:
        yield _install
    finally:
        if prior is None:
            try:
                del fastapi_app.state.settings
            except AttributeError:
                pass
        else:
            fastapi_app.state.settings = prior


async def _get(app) -> dict:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.get(URL_DEPLOYMENT_PREFIX)  # no Authorization header
    assert response.status_code == 200
    return response.json()


async def test_reports_configured_name_without_auth(app_with):
    assert await _get(app_with("dev")) == {"name": "dev"}


async def test_unnamed_deploy_reports_null(app_with):
    assert await _get(app_with(None)) == {"name": None}
