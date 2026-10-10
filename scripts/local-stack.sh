#!/usr/bin/env bash
# A complete qiita-miint stack on one developer machine: its own Postgres (in
# Docker), the data plane, the control plane and the compute orchestrator on the
# local backend, wired the way production wires them but rooted under one
# directory. Nothing it touches is shared: a private Postgres container and
# port, databases named qiita_local*, and $QIITA_LOCAL_ROOT for every path.
#
#   scripts/local-stack.sh up       start everything (idempotent)
#   scripts/local-stack.sh down     stop the services and the Postgres container
#   scripts/local-stack.sh status   what is running
#   scripts/local-stack.sh env      print the exports the CLI needs
#   scripts/local-stack.sh logs <dp|cp|co>
#
# Prerequisites: `make build-data-plane-debug` (or a release build), `make
# build-control-plane build-compute-orchestrator`, Docker, dbmate (`make
# dev-setup`). Container steps (bcl-convert) run under Docker when
# LOCAL_CONTAINER_IMAGES maps their SIF to a local image; see
# docs/runbooks/local-stack.md.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${QIITA_LOCAL_ROOT:-$HOME/.qiita-local/stack}"
PG_CONTAINER="${QIITA_LOCAL_PG_CONTAINER:-qiita-local-pg}"
PG_PORT="${QIITA_LOCAL_PG_PORT:-5435}"
CP_PORT="${QIITA_LOCAL_CP_PORT:-8180}"
CO_PORT="${QIITA_LOCAL_CO_PORT:-8181}"
DP_PORT="${QIITA_LOCAL_DP_PORT:-50151}"
DB="qiita_local"
LAKE_DB="qiita_local_ducklake"
PG_URL="postgresql://qiita:qiita@localhost:${PG_PORT}"

SECRETS="$ROOT/secrets"
RUN="$ROOT/run"
LOGS="$ROOT/logs"
SCRATCH="$ROOT/scratch"
PERSISTENT="$ROOT/persistent"
DERIVED="$ROOT/derived"
INGEST="$ROOT/ingest"
EXT_DIR="$DERIVED/duckdb-ext"

CP_PY="$REPO/qiita-control-plane/.venv/bin/python"
CO_PY="$REPO/qiita-compute-orchestrator/.venv/bin/python"

die() { echo "local-stack: $*" >&2; exit 1; }
log() { echo "local-stack: $*" >&2; }

dp_binary() {
    local b
    for b in release debug; do
        if [[ -x "$REPO/qiita-data-plane/target/$b/qiita-data-plane" ]]; then
            echo "$REPO/qiita-data-plane/target/$b/qiita-data-plane"
            return
        fi
    done
    die "no data-plane binary; run 'make build-data-plane-debug'"
}

duckdb_lib_dir() {
    # The binary links libduckdb dynamically when built with DUCKDB_DOWNLOAD_LIB=1.
    local d
    d="$(ls -d "$REPO"/qiita-data-plane/target/duckdb-download/*/* 2>/dev/null | sort -r | head -1)"
    echo "${d:-}"
}

ensure_dirs() {
    mkdir -p "$SECRETS" "$RUN" "$LOGS" "$SCRATCH/ticket" "$SCRATCH/staging" \
        "$PERSISTENT/ducklake" "$DERIVED/images" "$EXT_DIR" "$INGEST"
    chmod 700 "$SECRETS"
}

ensure_secrets() {
    [[ -x "$CP_PY" ]] || die "control-plane venv missing; run 'make build-control-plane'"
    if [[ ! -f "$SECRETS/signing.key" ]]; then
        "$CP_PY" - "$SECRETS" <<'PY'
import base64, os, sys
from pathlib import Path
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

d = Path(sys.argv[1])
seed = os.urandom(32)
pub = Ed25519PrivateKey.from_private_bytes(seed).public_key().public_bytes_raw()
for name, raw in {
    "signing.key": seed,
    "signing.pub": pub,
    "cookie.key": os.urandom(32),
    "cp-to-co.token": os.urandom(32),
}.items():
    p = d / name
    p.write_text(base64.b64encode(raw).decode() + "\n")
    p.chmod(0o600)
PY
        log "generated secrets in $SECRETS"
    fi
}

ensure_postgres() {
    if ! docker inspect "$PG_CONTAINER" >/dev/null 2>&1; then
        docker run -d --name "$PG_CONTAINER" -p "${PG_PORT}:5432" \
            -e POSTGRES_USER=qiita -e POSTGRES_PASSWORD=qiita -e POSTGRES_DB=postgres \
            postgres:17 >/dev/null
        log "created Postgres container $PG_CONTAINER on :$PG_PORT"
    elif [[ "$(docker inspect -f '{{.State.Running}}' "$PG_CONTAINER")" != "true" ]]; then
        docker start "$PG_CONTAINER" >/dev/null
    fi
    for _ in $(seq 1 60); do
        docker exec "$PG_CONTAINER" pg_isready -U qiita -q && break
        sleep 1
    done
    docker exec "$PG_CONTAINER" pg_isready -U qiita -q || die "Postgres did not become ready"
    local db
    for db in "$DB" "$LAKE_DB"; do
        if [[ -z "$(docker exec "$PG_CONTAINER" psql -U qiita -d postgres -Atc \
            "SELECT 1 FROM pg_database WHERE datname = '$db'")" ]]; then
            docker exec "$PG_CONTAINER" psql -U qiita -d postgres -qc "CREATE DATABASE $db"
        fi
    done
}

migrate_and_sync() {
    export DATABASE_URL="${PG_URL}/${DB}?sslmode=disable"
    make -s -C "$REPO" migrate >/dev/null
    (cd "$REPO/qiita-control-plane" && uv run -q qiita-admin actions sync --workflows-dir ../workflows) \
        >"$LOGS/actions-sync.log" 2>&1 || die "actions sync failed; see $LOGS/actions-sync.log"
    "$CP_PY" "$REPO/scripts/local_stack_bootstrap.py" "$SECRETS/admin.token" "$SECRETS/co-to-cp.token"
}

ensure_miint() {
    # Stage miint once, as the deploy does, into the one directory all three
    # services LOAD from; also installs the GPL-boundary host.
    [[ -x "$CO_PY" ]] || die "orchestrator venv missing; run 'make build-compute-orchestrator'"
    if [[ ! -f "$EXT_DIR/.gpl-boundary-path" ]]; then
        MIINT_EXTENSION_DIRECTORY="$EXT_DIR" "$CO_PY" - "$EXT_DIR" <<'PY' \
            || die "staging miint failed (DuckDB must reach the miint mirror; see docs/runbooks/local-stack.md)"
import sys
from pathlib import Path
import duckdb
from qiita_common.duckdb_miint import miint_connect_config, miint_install_sql, miint_load_sql

with duckdb.connect(":memory:", config=miint_connect_config()) as conn:
    conn.execute(miint_install_sql())
    conn.execute(miint_load_sql())
    path = conn.execute("SELECT install_gpl_boundary()").fetchone()[0]["path"]
Path(sys.argv[1], ".gpl-boundary-path").write_text(path + "\n")
PY
        log "staged miint into $EXT_DIR"
    fi
}

ingest_roots() {
    local roots="$INGEST:$SCRATCH/references/staging"
    [[ -n "${QIITA_LOCAL_EXTRA_INGEST_ROOTS:-}" ]] && roots="$roots:$QIITA_LOCAL_EXTRA_INGEST_ROOTS"
    echo "$roots"
}

pid_alive() { [[ -f "$RUN/$1.pid" ]] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }

start_one() {
    local name="$1"; shift
    if pid_alive "$name"; then
        log "$name already running (pid $(cat "$RUN/$name.pid"))"
        return
    fi
    nohup "$@" >"$LOGS/$name.log" 2>&1 &
    echo $! >"$RUN/$name.pid"
}

wait_http() {
    local name="$1" url="$2"
    for _ in $(seq 1 60); do
        curl -fsS -o /dev/null "$url" 2>/dev/null && return
        pid_alive "$name" || die "$name exited; see $LOGS/$name.log"
        sleep 1
    done
    die "$name did not answer at $url; see $LOGS/$name.log"
}

wait_port() {
    local name="$1" port="$2"
    for _ in $(seq 1 120); do
        nc -z 127.0.0.1 "$port" 2>/dev/null && return
        pid_alive "$name" || die "$name exited; see $LOGS/$name.log"
        sleep 1
    done
    die "$name did not open :$port; see $LOGS/$name.log"
}

start_services() {
    local gpl lib
    gpl="$(cat "$EXT_DIR/.gpl-boundary-path")"
    lib="$(duckdb_lib_dir)"
    local common=(
        PATH_SCRATCH="$SCRATCH"
        MIINT_EXTENSION_DIRECTORY="$EXT_DIR"
        MIINT_GPL_BOUNDARY_PATH="$gpl"
        DATA_PLANE_URL="grpc://127.0.0.1:$DP_PORT"
    )

    start_one dp env "${common[@]}" \
        LISTEN_ADDR="127.0.0.1:$DP_PORT" \
        FLIGHT_TICKET_PUBLIC_KEY="$(cat "$SECRETS/signing.pub")" \
        DUCKLAKE_CATALOG_CONNSTR="dbname=$LAKE_DB host=localhost port=$PG_PORT user=qiita password=qiita sslmode=disable" \
        PATH_PERSISTENT="$PERSISTENT" \
        DYLD_LIBRARY_PATH="$lib" LD_LIBRARY_PATH="$lib" \
        "$(dp_binary)"
    wait_port dp "$DP_PORT"

    start_one co env "${common[@]}" \
        COMPUTE_BACKEND=local \
        PATH_DERIVED="$DERIVED" \
        QIITA_CP_URL="http://127.0.0.1:$CP_PORT" \
        CP_TO_CO_TOKEN_PATH="$SECRETS/cp-to-co.token" \
        CO_TO_CP_TOKEN_PATH="$SECRETS/co-to-cp.token" \
        LOCAL_CONTAINER_IMAGES="${LOCAL_CONTAINER_IMAGES:-bcl-convert-4.5.4.sif=qiita/bcl-convert:4.5.4}" \
        ${QIITA_LOCAL_CONTAINER_DOCKER_HOST:+DOCKER_HOST="$QIITA_LOCAL_CONTAINER_DOCKER_HOST"} \
        "$REPO/qiita-compute-orchestrator/.venv/bin/uvicorn" qiita_compute_orchestrator.main:app \
        --host 127.0.0.1 --port "$CO_PORT"
    wait_http co "http://127.0.0.1:$CO_PORT/health"

    start_one cp env "${common[@]}" \
        DATABASE_URL="${PG_URL}/${DB}?sslmode=disable" \
        FLIGHT_TICKET_SIGNING_KEY="$(cat "$SECRETS/signing.key")" \
        LOGIN_COOKIE_SECRET_KEY="$(cat "$SECRETS/cookie.key")" \
        PATH_INGEST_ROOTS="$(ingest_roots)" \
        CONTACT_EMAIL="local-admin@localhost.localdomain" \
        COMPUTE_ORCHESTRATOR_URL="http://127.0.0.1:$CO_PORT" \
        CP_TO_CO_TOKEN_PATH="$SECRETS/cp-to-co.token" \
        "$REPO/qiita-control-plane/.venv/bin/uvicorn" qiita_control_plane.main:app \
        --host 127.0.0.1 --port "$CP_PORT"
    wait_http cp "http://127.0.0.1:$CP_PORT/health"
}

print_env() {
    cat <<EOF
export QIITA_BASE_URL=http://127.0.0.1:$CP_PORT
export QIITA_TOKEN=\$(cat $SECRETS/admin.token)
# ingest root for run folders: $INGEST
EOF
}

stop_one() {
    if pid_alive "$1"; then
        kill "$(cat "$RUN/$1.pid")" && log "stopped $1"
    fi
    rm -f "$RUN/$1.pid"
}

case "${1:-}" in
    up)
        ensure_dirs
        ensure_secrets
        ensure_postgres
        migrate_and_sync
        ensure_miint
        start_services
        log "up: control plane http://127.0.0.1:$CP_PORT"
        print_env
        ;;
    down)
        for s in cp co dp; do stop_one "$s"; done
        docker stop "$PG_CONTAINER" >/dev/null 2>&1 && log "stopped $PG_CONTAINER" || true
        ;;
    status)
        for s in dp co cp; do
            if pid_alive "$s"; then echo "$s running (pid $(cat "$RUN/$s.pid"))"; else echo "$s stopped"; fi
        done
        docker inspect -f "$PG_CONTAINER {{.State.Status}}" "$PG_CONTAINER" 2>/dev/null \
            || echo "$PG_CONTAINER absent"
        ;;
    env) print_env ;;
    logs) tail -n 100 -f "$LOGS/${2:?logs <dp|cp|co>}.log" ;;
    *) die "usage: $0 up|down|status|env|logs <dp|cp|co>" ;;
esac
