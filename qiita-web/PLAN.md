# Qiita Web UI — plan

The rule behind everything here: **one grid, one validator, one state object per
workflow.** Every surface that shows, builds, checks or edits columnar data (prep
sheets, metadata, uploads, pre-flights) uses `table/model.ts` + `ui/Sheet.svelte` for
the grid and metameq for the checks, and keeps its state the way library-prep does
(`src/lib/features/README.md`). A surface that needs something the grid lacks adds it
to `Sheet` for everyone, not a second grid.

## Status

| Area | State |
|---|---|
| Library-prep: steps ↔ sheet editor, both flows | Done, uncommitted. 87 unit + 18 browser tests. |
| Metadata: Samples tab on `Sheet` (read-only), metameq Validate | Done, uncommitted. Now `features/metadata/`. |
| Dashboard on `/` | Done, uncommitted. Server `granted_at` change ready in `~/Projects/Qiita-granted-at`, uncommitted. |
| Sequencing (3) | In progress in another session. |
| Metadata editing (2b) | Deferred. |
| Admin console: principals, dispatch throttle | First pass done. |
| Everything below "Next" | Not started. |

## What we build on

- **Grid** — `ui/Sheet.svelte`: the parent owns the rows; every change comes back as
  a `CellEdit[]` batch. Sort, filter, search, paste, fill, undo/redo, cell problems,
  `focusCell`. Every cell is text: formulas are off, because jspreadsheet runs a
  formula through `new Function` (a cell would otherwise be a script).
- **Problems** — `table/model.ts` `Problem`, shown on the cells and in
  `ui/ProblemList.svelte`, which jumps to the cell.
- **Edits** — `features/library-prep/edits.ts` + `load.ts`: route each edit to the
  state that owns its column; drop an edit that puts back the saved value; loading a
  file is a batch of edits, with conflicts held back and named. Metadata editing reuses
  these, not a copy.
- **metameq** — `metadataReview.ts` + `static/metadata_review.py` in the Pyodide
  worker.
- **Tickets** — `api.submitWorkTicket`, `api.ticket`, `api.ticketLogs`, and the
  `/tickets` pages. Every "launch a workflow" reuses them.
- **Roles** — `roles.ts`. The server is the gate; hiding a button is courtesy.

## Next

### 1. File names: one convention, one module

Every file the app hands a lab tech gets its name from one place,
`features/library-prep/naming.ts`, instead of a template string at each site (today:
`amplicon/sheets.ts` and `long-read/longReadSheet.ts`).

- **A name is parts joined by `_`**, each part taken from a fact of the prep and
  cleaned to `[A-Za-z0-9.-]`:
  - amplicon sheet: `<run date>_<primer set>_<project>_Plates_<n-m>.txt`
    (`20261016_IL515fBC_806_IBD_15663_Plates_1-2.txt`)
  - long-read run prep: `<run date>_<amplicon size>_<instrument>_run_prep.txt`
    (`20261016_5Kb_Revio_run_prep.txt`)
- **Today the primer part is hard-coded** to `IL515fBC_806` whatever primer set was
  chosen. It should come from the protocol.
- **A missing fact is not filled with a placeholder.** The name says which fact is
  missing, and Download says the file isn't ready yet. A `YYYYMMDD_…` file in a
  run folder is how two runs get mixed up.
- **Several files download as one.** A prep that spans studies builds one sheet per
  study. Today the app starts one download per file, which browsers prompt for or
  silently cut short. One file downloads as itself; several download as one zip,
  `<run date>_<primer set>_<run>.zip`, with each file named as above (`fflate`, MIT,
  ~8 kB).
- **Unit tests pin each name.** A property test checks that no fact can produce a name
  with a path separator, a space, or a clash between two studies' files.

To ask the wet lab: whether the project part is the Qiita `project_name` as is
(`IBD_15663` in our fixture, `IBD_CCFA_15663` on their file); whether long-read files
are `.txt` or `.tsv` (the code writes `.txt`, the file on disk is `.tsv`); and what a
zip should be called.

### 2. Metadata: validate, then edit

Moves into `features/metadata/` (from `src/lib/metadataValidate.ts`, `samples.ts` and
`studyMetadata.svelte.ts`), with tests beside it.

**2a. Validate stored metadata — done.** Validate in the `SampleGrid` toolbar; the
samples shaped into metameq's input and its findings placed back
(`features/metadata/validate.ts`, unit-tested). Not browser-tested: Validate needs the
Pyodide worker, which the browser tests don't load.

**2b. Edit and save.** The Samples-tab grid unlocks for users who can
write, with the same lock toggle as library-prep. The state is the edits made on top of
the loaded samples (`{biosample: {field: value}}`). An edit that restores the saved
value is dropped, so the edit list is always the real diff, and undo works.
- **Before saving:** "Review & save" lists the diff and re-runs metameq; errors block
  the save.
- **Saving:** one `PATCH …/by-unique-field/metadata` per changed sample, with
  `If-Match`. A sample someone else changed meanwhile fails alone, keeps its edits, and
  is named.
- **After saving:** reload the samples.

The server keeps no history of metadata values, so an overwrite is final. What protects
the data:
- the publication lock: a biosample on a published prep can't be changed at all;
- `If-Match`, so a save never overwrites a change it didn't see;
- the review step, which shows the diff before anything is sent.

As a cheap safety net, "Review & save" also downloads the changed samples' previous
values as a TSV, so a bad save can be loaded back.

Needs an `api.ts` method for the patch, and the write scope a study editor needs.

**2c. Add samples by typing.** The upload flow with an empty grid instead of a file:
columns from the study's fields, rows typed or pasted, metameq live, then the existing
bulk import. No new server work.

### 3. Sequencing: runs and pools

A **Sequencing** section (staff), Runs → Pools. A pool spans studies and is what
processing runs on, so it gets its own pages; the study page keeps its "pools that
touch this study" list as links into them.
- **Run detail:** the run and its pools.
- **Pool detail:** its samples, its completion rollup (demux state, mask counts), and
  links to processing (4) and launching (5).

All reads that already exist (some already in `api.ts`, unused).

### 4. Processing: per-sample stats and graphs

On the pool page: each sample's numbers through the pipeline. That means reads at
demux, mask and align, mask tallies, and assembly completeness/contamination. This
gives the built-but-unreachable `LineageGraph`, `lineage.ts`, `api.processing` and
`api.maskDefinition` a home. Graphs reuse the lineage explorer's plotting (Pyodide,
color/shape panels); no new chart library. Before the assembly card: find out where
CheckM numbers really come from (Flight only today).

### 5. Launching runs from `/workflows`

`/workflows` launches; the pool pages watch. Each submit-* gesture becomes a card: a
typed form, then submit and poll through the ticket pages.
- **Browser cards:** the browser can't read lab disks, so cards cover the
  upload-a-pre-flight path (like the amplicon card).
- **CLI-only gestures:** the disk-scanning ingests stay in the CLI, and their cards say
  so.
- **Pool processing:** host-filter and align launch from a pool, pre-filled.

Blocked on a real server-side pre-flight ingest; `/amplicon-run` is a shim.

### 6. Admin console — rest

Ticket cancel goes on the ticket page. Compute readiness becomes a status card. Mask
delete waits until someone needs it. Direct-database `qiita-admin` commands stay out
of the UI.

### 7. Public contribution link

A study owner shares a link through which someone without an account proposes
metadata for that one study.
- **Token:** the link carries a token scoped to one study and one operation, with an
  expiry, revocable, rate-limited and audited. Never an account token.
- **Staging:** contributions land in a queue the owner approves, so a leaked link can
  propose metadata but not change it.

This is mostly server work: a scope, a mint endpoint, confined verification, the
staging table. It needs a design with the backend owners before any UI.

### 8. Dashboard on `/`

`/` redirects to `/references` today. It becomes a home page that answers "what needs
me, and where was I". The layout follows the kit's home screen
(`page-examples/home-screens/01-sidebar`): a stats row, a main column, and a narrow
side column, in our theme. Components from the kit:
- **Stats row** (`data-display/stats/05-with-shared-borders`): my running tickets, my
  failed tickets in the last 7 days, my studies, and studies shared with me. Each one
  links to its list. (Samples awaiting a prep has no read to count from yet.)
- **Tickets** (`lists/stacked-lists`, with our `StatusPill`): my latest 50, active
  first, eight to a page with Previous/Next. A failed ticket shows the step it failed
  at. Rows link to `/tickets/[id]`.
- **Studies**: one card with two tabs (`Tabs`).
  - *Recent*: the ones opened in this browser (`recents.ts`).
  - *Shared*: newest first. Needs the small server change below.
- **Side column**: start a library prep (or resume a saved draft), upload metadata,
  and launch a workflow; a Catalogs card for reference databases and prep protocols,
  which left the sidebar (Workflows links them too). For staff, a compute-readiness card.
- **Empty state** (`feedback/empty-states/03-with-starting-points`): a new user with
  no studies and no tickets sees where to begin instead of empty boxes.

Data:
- **Tickets:** `GET /work-ticket` already lists the caller's own, with `state` and
  `active` filters.
- **Studies:** `GET /study?min_tier=read` already lists the studies owned by or shared
  with the caller (`access_via` says which).
- **Order of sharing:** the list is ordered by study, not by when it was shared. The
  grant time exists (`study_access.granted_at`) but isn't returned. A small Qiita PR
  adds the caller's `granted_at` to `StudySummary`, and the dashboard sorts by it.
  Until then, the section reads "Studies shared with you" in list order.

Each card loads on its own, so a slow or failing read empties one card, with a retry,
not the page. Each card's data shaping is plain TypeScript in `features/dashboard/`
with unit tests, plus one browser test against stubbed reads.

## Order

1. Commit library-prep (once approved), then file names (1).
2. Finish and test metadata Validate (2a); move metadata into `features/`.
3. Dashboard (8), with the `granted_at` Qiita PR alongside.
4. Metadata editing (2b).
5. Sequencing (3), then processing (4).
6. Add samples by typing (2c) and the rest of admin (6), as time allows.
7. Workflow cards (5) once pre-flight ingest exists; then the contribution link (7).

## Security

- **Cells are text** (see What we build on), with a browser test that a pasted
  payload stays text.
- **Content-Security-Policy:** none is set yet. When one is added, `script-src` needs
  `'wasm-unsafe-eval'` for Pyodide, and needs no `'unsafe-eval'` now that formulas are
  off.
- **Tokens:** an account token never goes into a URL or a shareable link.

## Open questions

- Write scope for study metadata, and does it differ for owner vs shared-write? (2b, 7)
- Is there a server-side pre-flight ingest yet, or only the `/amplicon-run` shim? (5)
- Contribution link: owner approval, or confined direct writes? (7)
- Where does CheckM come from for the UI? (4)
- The wet lab's file-name questions. (1)
