"""Local compute backend — runs native step modules in-process for dev/test.

After the upload-doput refactor, every workflow step in the system is
a native module (`module:` in the YAML), so this backend has just one
dispatch arm: the framework's `run_native_job`. Container-step support
lives on SlurmBackend, where it belongs in production.

LocalBackend is *synchronous*: it runs the module to completion at
submit time. It implements the decoupled submit/status/result interface
honestly — `submit_step` returns a terminal handle carrying the outputs
(compute_target=local, no SLURM job id), `status_step` is immediately
COMPLETED, and `result_step` returns the captured outputs — rather than
fabricating a job id it doesn't have.
"""

import asyncio
from pathlib import Path

from qiita_common.actions import STEP_LOGS_SUBDIR, STEP_OUTPUT_SUBDIR
from qiita_common.backend_failure import BackendFailure, FailureKind
from qiita_common.log_tail import read_text_tail
from qiita_common.models import StepStatus, WorkTicketFailureStage

from ..backend import (
    ComputeBackend,
    FoundJob,
    LocalStepHandle,
    StepHandle,
    StepStatusInfo,
    assert_container_scope_supported,
)
from ..jobs import flatten_native_inputs, run_native_job
from ..slurm.contract import JOB_PARAMS_FILENAME, JobParams
from ..slurm.verify import parse_outputs_map, verify_container_output
from .local_container import IMAGES_ENV, DockerRuntime


class LocalBackend(ComputeBackend):
    """Runs native-module steps in-process. Dev/test only.

    The production analogue is `SlurmBackend` (apptainer under SLURM for
    `container:` steps). Here a container step runs only when a
    `DockerRuntime` is configured (`LOCAL_CONTAINER_IMAGES`, see
    `backends/local_container.py`); without one it is refused loudly rather
    than silently bypassing SLURM-side concerns (resource limits, cgroups,
    image pinning).
    """

    def __init__(self, *, container_runtime: DockerRuntime | None = None) -> None:
        self._container_runtime = container_runtime

    async def submit_step(
        self,
        name: str,
        inputs: dict[str, Path],
        workspace: Path,
        *,
        scope_target: dict,
        work_ticket_idx: int,
        attempt: int = 0,  # noqa: ARG002 — local has no SLURM job to name per-attempt
        container: str | None = None,
        module: str | None = None,
        entrypoint: str | None = None,
        baseline_resources=None,
        # Container-only (bind + env into apptainer), and LocalBackend rejects
        # container steps below — so it can only ever arrive empty here.
        derived_inputs: dict[str, str] | None = None,  # noqa: ARG002 — protocol parity
    ) -> StepHandle:
        """Run the native module in-process to completion and return a
        terminal StepHandle (compute_target=local, no SLURM job id, the
        outputs in hand). Translates known internal failures into typed
        `BackendFailure` via the shared `run_native_job` dispatcher (which
        handles FileNotFoundError / ValueError / ValidationError
        mapping). The contract-violation branches here catch wire-shape
        misconfiguration the dispatcher wouldn't see."""
        if (container is None) == (module is None):
            # Symmetric with SlurmBackend's guard: both None (neither
            # runtime declared) and both set (ambiguous runtime) are
            # contract violations. The wire validator on StepSubmitRequest
            # catches this upstream; this guard protects direct callers
            # (tests, programmatic submission) so silently preferring
            # one runtime over the other can't happen.
            raise BackendFailure(
                kind=FailureKind.CONTRACT_VIOLATION,
                stage=WorkTicketFailureStage.STEP_RUN,
                step_name=name,
                reason="LocalBackend requires exactly one of `container` or `module` on the step",
            )
        if container is not None:
            if self._container_runtime is None:
                raise BackendFailure(
                    kind=FailureKind.CONTRACT_VIOLATION,
                    stage=WorkTicketFailureStage.STEP_RUN,
                    step_name=name,
                    reason=(
                        f"LocalBackend runs container step image {container!r} only under"
                        f" Docker: set {IMAGES_ENV} to map it to a local image."
                    ),
                )
            outputs = await self._run_container(
                name,
                inputs,
                workspace,
                scope_target=scope_target,
                work_ticket_idx=work_ticket_idx,
                container=container,
                entrypoint=entrypoint,
                baseline_resources=baseline_resources,
            )
            return LocalStepHandle(step_name=name, terminal_outputs=outputs)
        # Native step: delegate to the framework dispatcher. It validates
        # the module prefix, imports the module, validates raw_inputs via
        # `mod.Inputs`, invokes `mod.execute(inputs, workspace)`, and maps
        # known exceptions to typed BackendFailure. `flatten_native_inputs`
        # merges the scope-target idx scalars and rejects reserved-key
        # collisions the same way the SLURM launcher does — a job module
        # sees identical raw_inputs regardless of runtime.
        raw_inputs = flatten_native_inputs(
            {k: str(v) for k, v in inputs.items()},
            step_name=name,
            scope_target=scope_target,
            work_ticket_idx=work_ticket_idx,
        )
        outputs = await run_native_job(module, raw_inputs, workspace, step_name=name)
        return LocalStepHandle(step_name=name, terminal_outputs=outputs)

    async def _run_container(
        self,
        name: str,
        inputs: dict[str, Path],
        workspace: Path,
        *,
        scope_target: dict,
        work_ticket_idx: int,
        container: str,
        entrypoint: str | None,
        baseline_resources,
    ) -> dict[str, Path]:
        """Run a container step under Docker to completion, then verify and parse
        its output exactly as `SlurmBackend.result_step` does."""
        assert self._container_runtime is not None
        assert_container_scope_supported(step_name=name, scope_target=scope_target)

        def fail(kind: FailureKind, reason: str) -> BackendFailure:
            return BackendFailure(
                kind=kind, stage=WorkTicketFailureStage.STEP_RUN, step_name=name, reason=reason
            )

        image = self._container_runtime.images.get(container)
        if image is None:
            raise fail(
                FailureKind.CONTRACT_VIOLATION,
                f"container {container!r} has no Docker image in {IMAGES_ENV}",
            )
        if not entrypoint:
            raise fail(FailureKind.CONTRACT_VIOLATION, "container step requires an entrypoint")
        if baseline_resources is None:
            raise fail(FailureKind.CONTRACT_VIOLATION, "container step requires its resources")

        input_path = workspace / "input"
        output_path = workspace / STEP_OUTPUT_SUBDIR
        logs_path = workspace / STEP_LOGS_SUBDIR
        for d in (input_path, output_path, logs_path, workspace / "tmp"):
            d.mkdir(parents=True, exist_ok=True)
        (input_path / JOB_PARAMS_FILENAME).write_text(
            JobParams(
                step_name=name,
                scope_target=scope_target,
                work_ticket_idx=work_ticket_idx,
                inputs={k: str(v) for k, v in inputs.items()},
                output_path=str(output_path),
            ).model_dump_json(indent=2)
            + "\n"
        )
        bind_dirs = sorted({(p if p.is_dir() else p.parent).resolve() for p in inputs.values()})
        argv = self._container_runtime.command(
            image=image,
            entrypoint=entrypoint,
            workspace=workspace,
            work_ticket_idx=work_ticket_idx,
            cpus=baseline_resources.cpu,
            mem_mb=baseline_resources.mem_gb * 1024,
            bind_dirs=[d for d in bind_dirs if not d.is_relative_to(workspace)],
        )
        with (logs_path / "stdout").open("wb") as out, (logs_path / "stderr").open("wb") as err:
            proc = await asyncio.create_subprocess_exec(*argv, stdout=out, stderr=err)
            returncode = await proc.wait()
        if returncode != 0:
            tail, _ = read_text_tail(logs_path / "stderr", max_lines=20, max_bytes=8192)
            raise fail(
                FailureKind.EXIT_NONZERO, f"container exited {returncode}; stderr tail:\n{tail}"
            )

        failures = verify_container_output(output_path)
        if failures:
            detail = "; ".join(
                f.reason + (f" ({f.detail})" if f.detail else "") for f in failures[:5]
            )
            raise fail(
                FailureKind.CONTRACT_VIOLATION, f"container output failed verification: {detail}"
            )
        return parse_outputs_map(output_path)

    async def status_step(self, handle: StepHandle) -> StepStatusInfo:
        """Local steps run to completion at submit time, so status is
        always COMPLETED. Provided for interface parity; the runner skips
        polling when a handle already carries terminal_outputs."""
        del handle
        return StepStatusInfo(status=StepStatus.COMPLETED)

    async def result_step(self, handle: StepHandle, status: StepStatusInfo) -> dict[str, Path]:
        """Return the outputs captured at submit time. A non-COMPLETED
        status can't arise on the normal local path (submit_step either
        runs to completion or raises before returning a handle), so it's a
        caller bug — honor the ABC contract and fail loudly rather than
        return outputs for a step that didn't succeed."""
        if status.status != StepStatus.COMPLETED:
            raise BackendFailure(
                kind=FailureKind.UNKNOWN_PERMANENT,
                stage=WorkTicketFailureStage.STEP_RUN,
                step_name=handle.step_name,
                reason=f"LocalBackend.result_step called with non-COMPLETED status "
                f"{status.status.value!r}",
            )
        return handle.terminal_outputs

    async def find_jobs_by_name(self, job_name: str) -> list[FoundJob]:
        """LocalBackend runs steps in-process and never submits to SLURM, so
        there is never an orphaned job to find. Always empty — provided for
        interface parity so the CP→CO find-by-name route works against either
        backend without an isinstance check."""
        del job_name
        return []

    async def cancel(self, work_ticket_idx: int) -> list[int]:
        """LocalBackend runs steps in-process, so there is never a live SLURM job
        to scancel. Always empty — interface parity so the CP→CO cancel route works
        against either backend without an isinstance check."""
        del work_ticket_idx
        return []
