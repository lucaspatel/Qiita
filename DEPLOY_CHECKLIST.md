# Deploy checklist

Operator-facing deploy instructions — **not** a "what changed" log (that's [`CHANGELOG.md`](CHANGELOG.md); the git log is the authoritative record). `## Pending deploy` is the single consolidated checklist for the next deploy; past deploys are archived one file each under [`docs/deploy-archive/`](docs/deploy-archive/).

- **Deploying?** Follow [`docs/runbooks/redeploy.md`](docs/runbooks/redeploy.md) — it is the source of truth for the procedure (bucket order, `[admin]`/`[operator]` labels, the migration guard, archiving).
- **Adding to a PR?** Fold your operator steps into the `## Pending deploy` buckets with `/deploy-note`; don't add a standalone entry. The authoring rules are in CLAUDE.md ("Operator-facing changes").

Substitute your host's FQDN for the `qiita-miint.ucsd.edu` examples and `<scratch>` for the scratch root chosen at first deploy.

---

## Pending deploy

Everything merged but not yet deployed, folded in by each PR as it merges. Run buckets 1→6 in order; buckets 1–3 must precede the bucket-4 restart, and bucket 6 (irreversible cleanup — anything that burns the rollback path) must not run until bucket 5 is green. Each step carries its source `(#N)` tag.

### 1. Env vars — set BEFORE the deploy (most are `from_env()` fail-fast; a missing one keeps the unit down)

- `[operator]` **`PATH_INGEST_ROOTS` must cover the sequencer run-folder root(s).** No new
  variable — but `submit-golay-demux --instrument-run-id <id>` resolves the run folder by
  scanning `PATH_INGEST_ROOTS` for a directory whose basename matches the run id, so a run
  living under a path the roots don't cover cannot be submitted. Ensure the existing value
  includes wherever instruments copy runs. (#244)
- `[admin]` **Optional, recommended: name the deployment.** `QIITA_DEPLOYMENT_NAME` (CP) is
  served at `GET /api/v1/deployment` and shown by `qiita whoami` and the web UI's badge, so
  users can tell prod from a dev stack. Unset reports `null`; a malformed value (not a
  lowercase `[a-z0-9-]` slug, ≤32 chars) **fails CP boot**. (#feat/web-ui)
  ```
  sudo bash -c 'grep -q "^QIITA_DEPLOYMENT_NAME=" /etc/qiita/control-plane.env || echo "QIITA_DEPLOYMENT_NAME=prod" >> /etc/qiita/control-plane.env'   # (#feat/web-ui)
  ```

### 2. One-time host setup

_None yet._

### 3. Migrations

_None yet._

### 4. Deploy

_None yet._

### 5. Verify

- **Confirm the two amplicon workflows synced.** `golay-demux 1.0.0` and `amplicon 1.0.0`
  reach `qiita.action` via `qiita-admin actions sync` inside `activate.sh` — no migration.
  `make verify-deploy` lists `qiita.action`; check both appear. The new DuckLake
  `amplicon_membership`, `amplicon_sequence`, and `amplicon_sequence_chunks` tables are
  auto-created at data-plane boot (no migration, no action). `make verify-deploy`'s
  compute-readiness probe now includes a `miint-amplicon-fns` check that asserts the
  amplicon deblur functions (`align_sortmerna_rrna`, `detect_chimera_uchime_denovo`,
  `align_mafft`, `deblur`, `sequence_dna_as_regexp`) are registered in the staged miint
  build — a stale build missing one fails the deploy here, not at the first amplicon submit.
  The `amplicon` workflow additionally needs a SortMeRNA 16S database loaded as an ACTIVE
  `sequence_reference` (its `reference_idx` is a submit-time context arg) — a per-study data
  setup, not a deploy step. `golay-demux` now runs bcl-convert (a container step) before the
  demux, so it needs `bcl-convert-4.5.4.sif` present — the same SIF the `bcl-convert` workflow
  uses, rebuilt automatically at deploy — and a compute node that can run it. (#244)
- **Deployment name served:** `curl -s https://qiita-miint.ucsd.edu/api/v1/deployment` →
  `{"name":"prod"}` (`{"name":null}` if bucket 1's optional var was skipped). (#feat/web-ui)

### 6. After the deploy verifies green

_None yet._

### Notes (no host action)

_None yet._

## Deployed history

Past deploys live one file each in [`docs/deploy-archive/`](docs/deploy-archive/) — newest
first in its [index](docs/deploy-archive/README.md). `/deploy-archive` writes the next one
there when a deploy closes out.

(This heading has no content under it by design, and is not dead weight: it terminates the
`sed` range that prints `## Pending deploy` for the operator and for `/deploy-note`. See
`test_deployed_history_heading_pins_the_live_section_boundary`.)
