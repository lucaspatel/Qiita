# Local stack

A complete qiita-miint on one developer machine: a private Postgres container,
the data plane, the control plane and the compute orchestrator on its local
backend, all rooted under `~/.qiita-local/stack` (override with
`QIITA_LOCAL_ROOT`). Nothing is shared with the test harness or any deploy: its
own container (`qiita-local-pg`, port 5435), databases named `qiita_local*`, and
its own ports (CP 8180, CO 8181, DP 50151; each overridable, see the top of
`scripts/local-stack.sh`).

```bash
make local-up          # builds what it needs, then starts everything
eval "$(scripts/local-stack.sh env)"
qiita --base-url "$QIITA_BASE_URL" whoami
make local-status
scripts/local-stack.sh logs cp     # dp | cp | co
make local-down
```

`up` is idempotent: it creates the container and databases once, applies
migrations, syncs `workflows/`, stages miint, and starts whatever is not running.

## Identity

There is no identity provider locally, so `scripts/local_stack_bootstrap.py`
writes two principals straight into the stack's database (it refuses any database
not named `qiita_local*`): `local-admin` (system_admin, complete profile) whose
token the CLI and web UI use, and `local-compute`, the orchestrator's service
account. Each `up` mints fresh tokens into `secrets/`.

## Data

Run folders and reference FASTAs go under `~/.qiita-local/stack/ingest/`, the
stack's ingest root (`QIITA_LOCAL_EXTRA_INGEST_ROOTS` adds more, colon-separated).
Copy a run folder in whole, then submit as on a deploy:

```bash
qiita --base-url "$QIITA_BASE_URL" submit-golay-demux \
  --instrument-run-id <run-id> --preflight-blob <preflight.db> --prep-protocol-idx 4
```

## Container steps (bcl-convert)

The local backend runs a `container:` step under Docker when
`LOCAL_CONTAINER_IMAGES` maps its SIF filename to a local image
(`bcl-convert-4.5.4.sif=qiita/bcl-convert:4.5.4` is the default the stack sets).
The step sees the same contract it does under apptainer — params.json, the
`QIITA_*` variables, every path bound at its own location
(`backends/local_container.py`).

The bcl-convert image is x86-only and needs AVX, which QEMU does not provide. On
Apple silicon run it on a Rosetta VM and point the orchestrator at it:

```bash
colima start -p bclconvert --vm-type vz --vz-rosetta --cpu 8 --memory 16 \
  --mount ~/.qiita-local:w
# set mountInotify: false in ~/.colima/bclconvert/colima.yaml, then restart it
QIITA_LOCAL_CONTAINER_DOCKER_HOST=unix://$HOME/.colima/bclconvert/docker.sock make local-up
```

Build the image from the vendored RPM with a Dockerfile that mirrors
`workflows/bcl-convert/Apptainer.def` (the RPM is EULA-gated and not in git).
Two things the VM must satisfy:

- **The stack root must be inside the VM's mount** (`~/.qiita-local` above),
  since the container binds the step workspace and the run folder by host path.
- **`mountInotify: false`.** With colima's inotify propagation on, files written
  through the share revert to their creation mode shortly after the entrypoint's
  `chmod 0440`, and the output verifier rejects the step.

## When DuckDB cannot download extensions

Every service LOADs miint from `derived/duckdb-ext`, and the data plane LOADs
`ducklake` and `postgres` from DuckDB's own cache. If DuckDB's downloader fails
on your network (`Failed to write connection` even though `curl` reaches the
URL), fetch them by hand, for the DuckDB version the stack uses:

```bash
V=v1.5.5; P=osx_arm64; D=~/.qiita-local/stack/derived/duckdb-ext/$V/$P
mkdir -p $D ~/.duckdb/extensions/$V/$P
curl -sSL https://ftp.microbio.me/pub/miint/$V/$P/miint.duckdb_extension.gz | gunzip > $D/miint.duckdb_extension
for e in httpfs ducklake postgres_scanner; do
  curl -sSL http://extensions.duckdb.org/$V/$P/$e.duckdb_extension.gz | gunzip > $D/$e.duckdb_extension
done
cp $D/{ducklake,postgres_scanner}.duckdb_extension ~/.duckdb/extensions/$V/$P/
```
