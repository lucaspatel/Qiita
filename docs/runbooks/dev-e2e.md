# Dev deploy: rapid-16S end to end, with the web UI

Deploys branch `feat/web-ui` of `lucaspatel/Qiita` to the dev stack and proves, on a
real deployment, the path the local stack has run: a MiSeq i100 run → golay-demux by
matrix tube → amplicon 1.1.0 → the study lineage, the feature table and its plots in the
web UI, and the delivered metadata loaded over REST.

`feat/web-ui` is the deploy branch: `main` plus all work in progress, from which
features are later split into upstream PRs. Besides `main` it carries:

- the rapid-16S work: tube-keyed roster resolution, workflow follow-ons, the
  bcl-convert 4.x dummy sheet, QM identifiers, the `amplicon_sample` gate, the study
  lineage endpoint, and run feature tables (REST + `qiita feature-table runs`).
- the web UI: `qiita-web/`, plus named environments for the CLI and
  `GET /api/v1/deployment`.

None of it is upstream. Section 5 covers going back to `main`.

## 1. Operator: deploy the branch (on the dev host)

The dev stack's own procedure applies; these are the inputs it needs.

1. **Source.** Check out `feat/web-ui` from `https://github.com/lucaspatel/Qiita`.
2. **Build everything.** `make build`. The data plane changed (`flight_service.rs`: an
   amplicon read scoped to a bounded set of runs). The control plane's
   `run-preflight` pin moved to `lucaspatel/kl-run-preflight@e521060`, which accepts
   tube-identified pre-flights.
3. **Env (optional).** `QIITA_DEPLOYMENT_NAME=dev` in `control-plane.env` makes the
   CLI and the web UI show which deployment they're on. A value that isn't a lowercase
   `[a-z0-9-]` slug of 32 characters or fewer **fails CP boot**; leaving it unset is fine.
4. **Migrations.** `make migrate` applies four, all additive:
   - `20261006000000_exported_entity`: QS/QB handles, with a backfill for every existing
     study and biosample in one transaction. This one is on `main`.
   - `20261009000000_work_ticket_follow_on`: fork only.
   - `20261009000001_exported_identifier_processing`: QM identifiers per processed
     sample. Fork only.
   - `20261010000000_amplicon_sample`: the per-sample gate the lineage reads. Fork only.
5. **Restart** the control plane, orchestrator and data plane. The actions sync
   registers `amplicon` **1.1.0**, auto-deprecating 1.0.0 (a 1.0.0 ticket still
   unfinished at deploy can't run; resubmit it as 1.1.0), and its new library actions
   (`mint-amplicon-identifiers`, `finalize-amplicon-sample`).
6. **Images.** None are new. golay-demux still needs `bcl-convert-4.5.4.sif` staged;
   every amplicon 1.1.0 step is native.
7. **Verify.** `make verify-deploy`, then:
   - `curl http://<cp>/api/v1/deployment` returns `{"name":"dev"}` (or `null`);
   - the actions sync output (`qiita-admin actions sync`) reports `amplicon 1.1.0`
     registered.

## 2. Laptop: point the CLI and the UI at dev

```bash
ssh -L 18080:<node>:18080 -L 15051:<node>:15051 barnacle   # CP, and DP for the CLI bundle
cd ~/Projects/Qiita-web-ui/qiita-control-plane && uv sync   # the feat/web-ui worktree
uv run qiita env add dev http://localhost:18080 --adopt-token <your dev token file>
uv run qiita env use dev && uv run qiita whoami        # stderr names the deployment
cd ../qiita-web && npm install && npm run dev -- --port 5180
```

Open http://localhost:5180 and pick **dev** on the profile page. The UI calls dev through
the Vite proxy at `/_env/dev/api` (no CORS).

## 3. The proof

Run the steps in order. The study is dev's `IBD_15663` (25060), whose 192 biosamples
were registered by tube.

### 3a. Metadata, over REST

Add Samples can't take this sheet yet (section 4), so the loader does what it would
do. It matches rows by tube, then by owner sample id, patches the matched biosamples,
and bulk-creates the rest:

```bash
cd ~/Projects/Qiita-web-ui
python3 scripts/dev/load-study-metadata.py --api http://localhost:18080/api/v1 \
  --token-file <dev token file> --study 25060 \
  --sheet ~/Desktop/ibd-analysis/15663_20260928-110342.txt \
  --term-map scripts/dev/15663-term-map.json --dry-run      # then again without --dry-run
```

Expect about 190 rows matched by tube. Three tubes are claimed by two rows each, and
none of those rows gets its tube. The remaining ~650 rows are created. At the end the
loader lists what dev refused:

- **`qiita_sample_type` = `serum` / `control sample`:** dev's terminology seed has no
  such terms (the local stack got them by hand). A matched biosample is patched without
  that value. A new row needing it isn't created, which covers most serum and plasma
  rows. Seeding the two terms on dev and re-running the loader picks them up.
- **Matched biosamples keep their tube number as owner sample id:** REST can't rename
  one.

The loader is safe to re-run: a second run matches everything the first created.

### 3b. golay-demux

```bash
qiita submit-golay-demux --instrument-run-id 20260925_SL00377_0008_ASC2267726-SC3 \
  --preflight-blob IBD_15663_plates_5-6.preflight.db --prep-protocol-idx <rapid-16S protocol>
```

The run folder must sit **directly** under one of dev's `PATH_INGEST_ROOTS`, named
exactly as the run id (`<root>/20260925_SL00377_0008_ASC2267726-SC3`): the control plane
looks one level down, not deeper. It must be readable by the control plane's service
account, and visible at the same path on the compute nodes, where bcl-convert reads it.

The pre-flight identifies samples by tube. The CLI resolves them through
`POST /biosample/resolve-roster` and prints every problem against the sheet. If an
earlier attempt on dev completed, add `--force` (wet_lab_admin). Note the
`sequenced_pool_idx` and `sequencing_run_idx` it prints, and wait for the ticket to
complete. Expect 7 samples with no reads at demux; the local run saw the same.

### 3c. amplicon 1.1.0

```bash
qiita ticket submit --action-id amplicon --action-version 1.1.0 \
  --scope-target-json '{"kind":"sequenced_pool","sequenced_pool_idx":<P>,"sequencing_run_idx":<R>}' \
  --context-json '{"sortmerna_reference_idx":<SortMeRNA 16S reference_idx>,"trim":150}'
```

`qiita reference list` (or `GET /api/v1/reference`) gives the SortMeRNA reference.
The local run used `trim: 150` with no primer.

### 3d. What to check

| Where | Expect (local run, same inputs) |
|---|---|
| UI → study 25060 → **Samples** | First column is the accession, else QB; every delivered column shows; the local-metadata switch shades local columns |
| UI → **Processing** | One DAG: Run → Reads → ASVs → Feature table, with per-sample states; the producing action appears on arrow hover |
| Feature table node | 173 samples × 4028 ASVs; PCoA with a rarefaction slider; color/shape by any metadata column; PERMANOVA re-run on each change |
| `qiita feature-table runs --processing-idx <run> --study-idx 25060 --format biom --output ibd.biom` | BIOM 4028 × 173, total count 12,750,700, matching the REST table |
| UI → **Add samples**, drop the sheet | Validation runs on drop (about 15 s the first time); the review grid and the fixes work. **Don't upload** (section 4). |

The sample, ASV and count figures are the local run's. Dev should reproduce them
exactly, given the same reads and parameters; a difference is the finding.

## 4. Known gaps on this branch

- **Add Samples can't upload the 15663 sheet.**
  - 843 rows × about 60 values is over the bulk import's 25,000-value cap.
  - Rows for existing tubes would 409; there's no update path.
  - Terminology values must be term ids, and no route lists a deployment's terms.

  The loader in 3a works around all three.
- **The UI's dev proxy times out after 8 s** (`proxyTimeout` in `vite.config.ts`). A
  feature table fetched through the tunnel could exceed that; raise the timeout if the
  feature table node errors with "backend unreachable".
- **Owner-id uniqueness is per field, not per study.** Add Samples now locks to the
  study's own sample-id field, which closes the hole for the UI, but the API still
  allows it.

## 5. Going back to `main`

Redeploy `main`. All four migrations are additive and `main`'s code ignores the
fork-only columns and tables, so they can stay. To remove them, run
`dbmate rollback` three times, newest first (`amplicon_sample`,
`exported_identifier_processing`, `work_ticket_follow_on`), before redeploying.
Don't roll back `exported_entity`: it's on `main`.
