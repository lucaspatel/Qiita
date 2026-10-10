"""LocalBackend's optional container arm: a `container:` step run under Docker.

Off by default: with no `LOCAL_CONTAINER_IMAGES` the backend refuses container
steps as before. On, it follows the cluster's container contract exactly —
params.json in `<workspace>/input`, the QIITA_* contract vars, every path bound at
the same location inside the container, and the output verified against its
manifest — so a step that passes here behaves the same under apptainer.

The dispatch test drives a fake `docker` (a shell script that honours `-e` and
`--entrypoint` and ignores the rest) so it runs without a Docker daemon.
"""

from __future__ import annotations

import json
import os
import stat
import sys
import textwrap
from pathlib import Path
from types import SimpleNamespace

import pytest
from qiita_common.backend_failure import BackendFailure, FailureKind

from qiita_compute_orchestrator.backends.local import LocalBackend
from qiita_compute_orchestrator.backends.local_container import DockerRuntime

_REPO = Path(__file__).resolve().parents[2]
_MANIFEST_WRITER = _REPO / "workflows" / "_shared" / "manifest_writer.py"
_RESOURCES = SimpleNamespace(cpu=4, mem_gb=8, walltime_seconds=60, gpu=0)
_SCOPE = {"kind": "sequenced_pool", "sequenced_pool_idx": 3, "sequencing_run_idx": 2}


def test_from_env_is_off_when_unset(monkeypatch):
    monkeypatch.delenv("LOCAL_CONTAINER_IMAGES", raising=False)
    assert DockerRuntime.from_env() is None


def test_from_env_parses_the_image_map(monkeypatch):
    monkeypatch.setenv(
        "LOCAL_CONTAINER_IMAGES", "bcl-convert-4.5.4.sif=qiita/bcl-convert:4.5.4, x.sif=y:1"
    )
    monkeypatch.setenv("LOCAL_DOCKER_BIN", "/opt/bin/docker")
    runtime = DockerRuntime.from_env()
    assert runtime == DockerRuntime(
        images={"bcl-convert-4.5.4.sif": "qiita/bcl-convert:4.5.4", "x.sif": "y:1"},
        docker_bin="/opt/bin/docker",
    )


@pytest.mark.parametrize("raw", ["no-equals", "=img", "a.sif=", "a.sif=x,a.sif=y"])
def test_from_env_refuses_a_malformed_map(monkeypatch, raw):
    monkeypatch.setenv("LOCAL_CONTAINER_IMAGES", raw)
    with pytest.raises(ValueError, match="LOCAL_CONTAINER_IMAGES"):
        DockerRuntime.from_env()


def test_command_mirrors_the_apptainer_contract(tmp_path):
    runtime = DockerRuntime(images={"a.sif": "img:1"})
    ws = tmp_path / "ws"
    argv = runtime.command(
        image="img:1",
        entrypoint="/opt/qiita/entrypoint.sh",
        workspace=ws,
        work_ticket_idx=9,
        cpus=4,
        mem_mb=8192,
        bind_dirs=[Path("/data/run")],
    )
    assert argv[:4] == ["docker", "run", "--rm", "--platform=linux/amd64"]
    joined = " ".join(argv)
    for expected in (
        f"--volume={ws}:{ws}",
        "--volume=/data/run:/data/run:ro",
        f"--env=QIITA_INPUT_PATH={ws}/input",
        f"--env=QIITA_OUTPUT_PATH={ws}/output",
        "--env=QIITA_WORK_TICKET_IDX=9",
        "--env=QIITA_CPUS=4",
        "--env=QIITA_MEM_MB=8192",
        f"--env=TMPDIR={ws}/tmp",
        f"--env=HOME={ws}",
        f"--user={os.getuid()}:{os.getgid()}",
    ):
        assert expected in joined, expected
    assert argv[-2:] == ["--entrypoint=/opt/qiita/entrypoint.sh", "img:1"]


async def test_container_steps_still_refused_without_a_runtime(tmp_path):
    with pytest.raises(BackendFailure) as exc:
        await LocalBackend().submit_step(
            "bcl_convert",
            {},
            tmp_path,
            scope_target=_SCOPE,
            work_ticket_idx=1,
            container="a.sif",
            entrypoint="/e.sh",
            baseline_resources=_RESOURCES,
        )
    assert exc.value.kind == FailureKind.CONTRACT_VIOLATION
    assert "LOCAL_CONTAINER_IMAGES" in exc.value.reason


async def test_an_unmapped_image_is_refused(tmp_path):
    backend = LocalBackend(container_runtime=DockerRuntime(images={"other.sif": "x:1"}))
    with pytest.raises(BackendFailure) as exc:
        await backend.submit_step(
            "bcl_convert",
            {},
            tmp_path,
            scope_target=_SCOPE,
            work_ticket_idx=1,
            container="a.sif",
            entrypoint="/e.sh",
            baseline_resources=_RESOURCES,
        )
    assert exc.value.kind == FailureKind.CONTRACT_VIOLATION
    assert "a.sif" in exc.value.reason


def _fake_docker(tmp_path: Path) -> Path:
    """`docker run ... --env=K=V ... --entrypoint=E IMAGE`: export each env, exec E."""
    script = tmp_path / "docker"
    script.write_text(
        textwrap.dedent(
            """\
            #!/bin/bash
            set -euo pipefail
            entry=""
            for arg in "$@"; do
              case "$arg" in
                --env=*) export "${arg#--env=}" ;;
                --entrypoint=*) entry="${arg#--entrypoint=}" ;;
              esac
            done
            exec "$entry"
            """
        )
    )
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return script


def _entrypoint(tmp_path: Path, body: str) -> Path:
    script = tmp_path / "entrypoint.sh"
    script.write_text("#!/bin/bash\nset -euo pipefail\n" + body)
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return script


async def test_runs_the_container_and_returns_its_manifest_outputs(tmp_path):
    entry = _entrypoint(
        tmp_path,
        textwrap.dedent(
            f"""\
            jq -e '.inputs.samplesheet' "$QIITA_INPUT_PATH/params.json" >/dev/null
            mkdir -p "$QIITA_OUTPUT_PATH/ConvertJob"
            echo "cpus=$QIITA_CPUS" > "$QIITA_OUTPUT_PATH/ConvertJob/out.txt"
            chmod 0440 "$QIITA_OUTPUT_PATH/ConvertJob/out.txt"
            {sys.executable} {_MANIFEST_WRITER} "$QIITA_OUTPUT_PATH" convert_dir=ConvertJob
            chmod 0440 "$QIITA_OUTPUT_PATH/manifest.json"
            """
        ),
    )
    sheet = tmp_path / "prep" / "samplesheet.csv"
    sheet.parent.mkdir()
    sheet.write_text("[Header]\n")
    backend = LocalBackend(
        container_runtime=DockerRuntime(
            images={"a.sif": "img:1"}, docker_bin=str(_fake_docker(tmp_path))
        )
    )
    ws = tmp_path / "ws"
    ws.mkdir()
    handle = await backend.submit_step(
        "bcl_convert",
        {"samplesheet": sheet},
        ws,
        scope_target=_SCOPE,
        work_ticket_idx=5,
        container="a.sif",
        entrypoint=str(entry),
        baseline_resources=_RESOURCES,
    )
    outputs = handle.terminal_outputs
    assert set(outputs) == {"convert_dir"}
    assert (outputs["convert_dir"] / "out.txt").read_text() == "cpus=4\n"
    params = json.loads((ws / "input" / "params.json").read_text())
    assert params["inputs"] == {"samplesheet": str(sheet)}
    assert params["work_ticket_idx"] == 5


async def test_a_failing_container_is_exit_nonzero_with_its_stderr(tmp_path):
    entry = _entrypoint(tmp_path, 'echo "bcl-convert: no BCLs" >&2\nexit 3\n')
    backend = LocalBackend(
        container_runtime=DockerRuntime(
            images={"a.sif": "img:1"}, docker_bin=str(_fake_docker(tmp_path))
        )
    )
    ws = tmp_path / "ws"
    ws.mkdir()
    with pytest.raises(BackendFailure) as exc:
        await backend.submit_step(
            "bcl_convert",
            {},
            ws,
            scope_target=_SCOPE,
            work_ticket_idx=5,
            container="a.sif",
            entrypoint=str(entry),
            baseline_resources=_RESOURCES,
        )
    assert exc.value.kind == FailureKind.EXIT_NONZERO
    assert "no BCLs" in exc.value.reason
    assert "no BCLs" in (ws / "logs" / "stderr").read_text()
