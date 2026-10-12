"""The step-log shape: stamped narrative lines, one receipt, per-step capture."""

import asyncio
import json
import logging

from qiita_common.step_log import (
    COMPLETED_KIND,
    capture_to,
    listed,
    receipt,
    step_scope,
    summarize,
    write_receipt,
)


def test_capture_writes_only_its_own_steps_lines(tmp_path):
    log = logging.getLogger("qiita_common.tests.step_log")
    log.setLevel(logging.INFO)

    async def step(name: str, logs, gate: asyncio.Event, other: asyncio.Event):
        with capture_to(logs, name):
            log.info("hello from %s", name)
            gate.set()
            await other.wait()
            summarize(rows=len(name))

    async def both():
        a, b = asyncio.Event(), asyncio.Event()
        await asyncio.gather(
            step("denoise", tmp_path / "a", a, b), step("mint-features", tmp_path / "b", b, a)
        )

    asyncio.run(both())
    a = (tmp_path / "a" / "stderr").read_text().splitlines()
    b = (tmp_path / "b" / "stderr").read_text().splitlines()
    assert len(a) == 1 and a[0].endswith("INFO denoise: hello from denoise")
    assert len(b) == 1 and b[0].endswith("INFO mint-features: hello from mint-features")


def test_summarize_lands_on_the_running_step_and_is_inert_outside_one():
    summarize(ignored=1)
    with step_scope("profile") as scope:
        summarize(samples=3)
        summarize(genomes=40)
    assert scope.summary == {"samples": 3, "genomes": 40}


def test_receipt_is_one_json_line(tmp_path):
    write_receipt(tmp_path, receipt(COMPLETED_KIND, "denoise", summary={"asvs": 7}))
    write_receipt(tmp_path, receipt("bad_input", None, reason="no reads"))
    lines = (tmp_path / "stdout").read_text().splitlines()
    assert [json.loads(line) for line in lines] == [
        {"kind": "completed", "step_name": "denoise", "summary": {"asvs": 7}},
        {"kind": "bad_input", "step_name": None, "reason": "no reads"},
    ]


def test_listed_names_the_first_few():
    assert listed([1, 2]) == "1, 2"
    assert listed(list(range(25))).endswith(", 19, … (5 more)")
