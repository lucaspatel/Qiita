# Library-prep submit: the resolve-or-create gesture (spec, not yet built)

How the Library-prep wizard turns a finished prep into registered Qiita-miint
entities. Covers the long-read (PacBio amplicon) flow first, but the shape is the
same for short-read. **This is a design spec — none of it is implemented yet.**

## Principle: the data is the key (no idempotency key)

A prep *is* its data: the same barcode map + the same run is, by definition, the
same prep. Every entity Qiita-miint creates is already keyed on intrinsic data —
the run on `instrument_run_id`, a biosample on its matrix tube / accession, a pool
on its pre-flight content, a ticket on the one-in-flight-per-scope-target guard.
So a replay of the same prep (a double-click, a network retry, a resumed draft)
**converges to the same entities** with no client-generated idempotency key.

For that to hold, **every step of the gesture must be resolve-or-create** — look
up by the natural key, create only what is missing, never strict-insert. Two
places do not satisfy that today (see Gaps).

## The gesture

One server-side endpoint (`POST /library-prep/submit`, shape TBD) takes the whole
prep and performs the fan-out in dependency order. The UI makes **one** call and
stays a form; the server owns ordering and partial-failure recovery.

Input (long-read example):

```
{
  instrument_run_id, run_date, instrument_model,       # run
  protocol: { fwd_primer, rev_primer, umi_pattern, target_gene, target_subfragment, ... },
  samples: [ { sample_name, barcode_id, smrt_cell_well, movie_context,
               identity: { matrix_tube_id } | { biosample_accession, bioproject_accession },
               project, sample_type } ]
}
```

Steps, each resolve-or-create:

1. **Run** — find-or-create `sequencing_run` on `instrument_run_id`.
   *(already find-or-create — `ON CONFLICT (instrument_run_id)`.)*
2. **Biosamples** — for each sample, **resolve by matrix tube / accession; create
   only the missing ones.** A sample whose biosample already exists is reused, not
   rejected. *(GAP — see below.)*
3. **Pre-flight + pool** — if the run already has a pool, reuse it. Otherwise author
   the pre-flight via kl-run-preflight's typed builders
   (`create_run` → `add_project`/`add_input_plate` → `add_pacbio_sample` per sample
   → `set_amplicon_details`), then find-or-create the `sequenced_pool`. Keying the
   reuse on *the run already having a pool* sidesteps blob byte-determinism (see
   Gaps). *(pool is already find-or-create on `(run, run_preflight_sha256)`.)*
4. **Roster** — resolve every pool row to its biosample + studies through the
   existing `POST /biosample/resolve-roster` (read-only). After step 2 every row
   resolves.
5. **Ingest ticket** — submit the pool-scoped ingest work-ticket. The
   one-in-flight-per-scope-target guard makes a duplicate submit a no-op (409 while
   the first is non-terminal). *(already guarded.)*

Response: the run / pool / biosample ids and the ticket, so the UI can clear its
draft and switch to showing server-backed truth.

## Gaps to close before this is replay-safe

1. **Biosample registration is strict-insert, not resolve-or-create.** The import
   path raises on an existing natural key (`"matrix_tube_id already in use"`,
   `"biosample_accession already in use"`), so replaying "register these
   biosamples" errors instead of converging. The gesture's biosample step must
   **resolve-by-tube/accession first and create only the missing** — the
   find-or-create pattern already exists (`resolve_or_import_biosample_by_ena_accession`);
   it needs to be the path this gesture uses.

2. **Pool identity is on the pre-flight blob bytes** (`run_preflight_sha256` =
   `sha256(run_preflight_blob)`). A re-authored SQLite file can differ byte-for-byte
   from identical inputs (rowid/autoincrement, page layout), so re-authoring on a
   retry could mint a *second* pool. Avoid it by **resolving the pool via the run**
   (step 3: if the run already has a pool, reuse — do not re-author), rather than
   relying on byte-stable blobs.

## Why this composes with the client draft cache

The wizard autosaves to `localStorage` and clears the draft once submitted (the
run/pool then live on the server). Because the gesture is resolve-or-create
throughout, a resumed draft that re-submits **converges on the same entities** —
local scratch and the idempotent server gesture reinforce each other, with no
identity machinery on either side.
