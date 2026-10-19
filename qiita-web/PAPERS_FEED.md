# Papers feed — a morning list of metagenomics papers with public data

A dashboard surface: every morning, the new metagenomics/microbiome papers whose data
is publicly deposited, newest first, filterable by journal, each one-click-importable
into the ENA ingestion workflow and one-click-openable at the publisher.

This builds on the Europe PMC source analysis (the scheduler/SQLite/scoring/dedup design
stands). This doc covers the two things that make the feed *actionable* — detecting
"has public data" and wiring to ENA import — plus the dashboard UX.

## The core idea: a paper is useful here only if we can pull its data

The feed is not "new papers about metagenomics"; it's "new papers we can act on." So the
gating fact per paper is **does it report a public sequence-data accession** (ENA/SRA
study, BioProject), because that accession is exactly what our ENA ingestion workflow
takes. The feed's primary filter is *available data*, and the primary action is *import
that data*.

### Detecting available data (the key technical choice)

Europe PMC text-mines **accession numbers** from full text and exposes them per record
(databases include ENA, BioProject/PRJ, SRA, BioSample). The sync step, for each article:

1. pull its text-mined accessions (Europe PMC accession annotations for the id);
2. keep the ones in the databases we ingest (ENA study `ERP/SRP/DRP`, BioProject `PRJ…`,
   and the study-level forms `PRJNA/PRJEB/PRJDB`);
3. store them on the article; `has_data = accessions.length > 0`.

A paper with `isOpenAccess=Y` + a PMCID but no deposited accession is *readable* but not
*importable* — it shows in an "all" view, not the default "has data" view. (Confirm the
exact Europe PMC accession endpoint/shape during build — the user verified the search API
live; the accession annotations are the piece to pin down. Fallback: regex `PRJ(NA|EB|DB)\d+`
and `([EDS]RP\d{6,})` over title/abstract/available full text.)

### The ENA wiring

Our control plane already ingests by accession: `submitEnaImport(accessions)` →
`POST /ena-import-batch`, surfaced today by `EnaImportModal`. So the feed's **Import**
button opens that same modal **pre-filled with the paper's study accessions** — no new
backend. The modal already submits a batch and polls per-item status. One path, reused.

## Service shape (per the Europe PMC analysis)

A small process (its own service, or an ankusha source):

```
scheduler (every few hours)
  └ fetch   Europe PMC search: <focus terms> AND FIRST_IDATE:[last run − 3d TO today]
            SRC:MED (PubMed) + SRC:PPR (preprints: bioRxiv, medRxiv, …)
  └ enrich  per record: text-mined accessions → keep ENA/BioProject → has_data
  └ score   keyword weights over title+abstract (ankusha scoreText)
  └ upsert  SQLite articles(...)
GET /recent?days=7&min=2&has_data=1&journals=... → JSON
```

- **Filter on FIRST_IDATE** (index date), not publication date — publication dates are
  often past/future; the analysis found 0 vs 409 records for a 7-day window.
- **Dedup on DOI, PMID fallback.** A preprint and its journal version differ by DOI; link
  them only if needed (bioRxiv reports the published DOI).
- SQLite earns its place via `first_seen_at` ("new since last check"), stable ranking, and
  dedup. Stateless-with-cache is the fallback if "what's new" isn't needed.

### Schema (adds the data/journal fields the dashboard needs)

```
articles(
  id, pmid, pmcid, doi, source,          -- identity
  title, abstract, journal, journal_norm,-- display + journal filter (normalized key)
  indexed_on, first_seen_at,             -- recency + "new today"
  score, matched,                        -- relevance
  is_open_access, has_data,              -- the "readable" / "importable" flags
  data_accessions                        -- JSON: the ENA/BioProject accessions to import
)
```

## Dashboard UX

Lives on **Home** as a "New papers" card (and/or a full `/papers` page for the long list).

**Default view** — what you see each morning:
- **Filtered to `has_data`** (importable papers only; a toggle reveals readable-only too).
- **Sorted by recency** (`indexed_on` desc), with a **"new today"** marker from
  `first_seen_at`.
- A **journal filter** as a row of toggle chips, with a sensible default set **on**:
  the Nature sub-family plus a few microbiome venues (below). "All journals" clears it.

**Per paper (one row):**
- Title → links to the publisher (DOI resolver), opens in a new tab — *encourages reading*.
- Journal · date · a **new** dot if first-seen today · relevance score.
- The **data accessions** as small chips (`PRJNA…`, `ERP…`).
- **Import** button → opens `EnaImportModal` pre-filled with those accessions.
- Secondary links: PubMed (PMID), full text (PMCID, when open-access).

**Controls in the card header:**
- `Has data` toggle (default on) · recency is the default sort · a journal-chip row ·
  a days window (default 7).

### Default journal set (editable)

On by default — the venues most likely to carry importable human/microbiome metagenomics:

- **Nature family:** Nature, Nature Microbiology, Nature Medicine, Nature Methods,
  Nature Biotechnology, Nature Communications, Nature Genetics, Nature Ecology & Evolution.
- **Microbiome/genomics:** Microbiome, Cell Host & Microbe, Cell Genomics, Genome Biology,
  Genome Medicine, mSystems, The ISME Journal, Gut, Nucleic Acids Research.
- **Preprints** (shown, flagged as preprint): bioRxiv, medRxiv.

Journals are matched on a **normalized key** (`journal_norm`: lowercased, punctuation
stripped) because Europe PMC's journal strings vary ("Nat Microbiol" vs "Nature
Microbiology"). The default set and its aliases live in one config the user can edit; the
chip row also lets you turn any on/off ad hoc, and "+ more" reveals the long tail actually
present in the current window.

## Phasing

1. **Stateless demo (UI-first).** A `/papers` page that queries Europe PMC per request
   (hour cache), extracts accessions, renders the list + journal filter + Import wiring to
   `EnaImportModal`. No scheduler, no SQLite — proves the UX and the ENA path. "New today"
   is absent until step 2.
2. **The service.** Add the scheduler + SQLite + `/recent` so the list is "new since last
   check," ranked and deduped; the page reads `/recent`.
3. **Refinements.** Preprint→published linking, embeddings for relevance, saved journal
   profiles per user, a daily email digest.

## Open questions
- Europe PMC accession-annotation endpoint/shape — confirm vs the regex fallback.
- Where the service runs (standalone vs an ankusha source vs a control-plane job) and who
  schedules it.
- Does `submitEnaImport` accept BioProject `PRJ…` directly, or must we resolve PRJ→ERP
  first? (Decides whether the Import button needs a resolve step.)
- Default days window and `min` score; the editable journal set's home.
