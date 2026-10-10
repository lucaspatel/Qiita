"""Docker runtime for LocalBackend's container steps (dev only).

Production runs `container:` steps under apptainer on SLURM. A developer's
machine has Docker instead, so LocalBackend can run the same step image under
Docker when `LOCAL_CONTAINER_IMAGES` maps each SIF filename a workflow names to a
local Docker image (`bcl-convert-4.5.4.sif=qiita/bcl-convert:4.5.4,...`). The
command reproduces the apptainer contract built in `slurm/payload.py`: the same
QIITA_* vars, TMPDIR and HOME under the workspace, and every path bound at its
own location so params.json's host paths resolve unchanged inside the container.
Inputs are bound read-only; apptainer binds them writable, but no step writes
its inputs, and a dev machine is where an accidental write would land on the
only copy of a run folder.

`--platform` defaults to linux/amd64 because the step images are x86 builds; on
an Apple-silicon host point `DOCKER_HOST` at a Rosetta-backed engine (QEMU lacks
the AVX bcl-convert needs).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from qiita_common.actions import STEP_OUTPUT_SUBDIR

IMAGES_ENV = "LOCAL_CONTAINER_IMAGES"
DOCKER_BIN_ENV = "LOCAL_DOCKER_BIN"
PLATFORM_ENV = "LOCAL_DOCKER_PLATFORM"


@dataclass(frozen=True)
class DockerRuntime:
    images: dict[str, str] = field(default_factory=dict)
    docker_bin: str = "docker"
    platform: str = "linux/amd64"

    @classmethod
    def from_env(cls) -> DockerRuntime | None:
        """The runtime `LOCAL_CONTAINER_IMAGES` describes, or None when unset
        (container steps stay refused). A malformed map raises."""
        raw = os.environ.get(IMAGES_ENV, "").strip()
        if not raw:
            return None
        images: dict[str, str] = {}
        for pair in raw.split(","):
            sif, sep, image = (part.strip() for part in pair.partition("="))
            if not sep or not sif or not image:
                raise ValueError(f"{IMAGES_ENV}: expected <sif>=<image>, got {pair.strip()!r}")
            if sif in images:
                raise ValueError(f"{IMAGES_ENV}: {sif!r} is mapped twice")
            images[sif] = image
        return cls(
            images=images,
            docker_bin=os.environ.get(DOCKER_BIN_ENV, "docker"),
            platform=os.environ.get(PLATFORM_ENV, "linux/amd64"),
        )

    def command(
        self,
        *,
        image: str,
        entrypoint: str,
        workspace: Path,
        work_ticket_idx: int,
        cpus: int,
        mem_mb: int,
        bind_dirs: list[Path],
    ) -> list[str]:
        input_path = workspace / "input"
        output_path = workspace / STEP_OUTPUT_SUBDIR
        argv = [
            self.docker_bin,
            "run",
            "--rm",
            f"--platform={self.platform}",
            f"--user={os.getuid()}:{os.getgid()}",
            f"--workdir={workspace}",
            f"--volume={workspace}:{workspace}",
        ]
        argv += [f"--volume={d}:{d}:ro" for d in bind_dirs]
        env = {
            "QIITA_INPUT_PATH": input_path,
            "QIITA_OUTPUT_PATH": output_path,
            "QIITA_WORK_TICKET_IDX": work_ticket_idx,
            "QIITA_CPUS": cpus,
            "QIITA_MEM_MB": mem_mb,
            "TMPDIR": workspace / "tmp",
            "HOME": workspace,
        }
        argv += [f"--env={name}={value}" for name, value in env.items()]
        argv += [f"--entrypoint={entrypoint}", image]
        return argv
