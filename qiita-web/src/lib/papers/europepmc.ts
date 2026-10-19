// Stateless papers feed: query Europe PMC from the browser, cache the response for an
// hour in localStorage, and shape results into the dashboard's Paper. No backend, no key.
// This is phase 1 of PAPERS_FEED.md — the real "new since last check" needs the service.
//
// "Available data" here is detected by scanning title+abstract for ENA/BioProject study
// accessions (the regex fallback). That misses accessions that live only in a paper's
// data-availability section; the real version reads Europe PMC's accession annotations.

import { scopedKey } from '$lib/environment';

export type Paper = {
  id: string;
  source: string; // MED (PubMed), PPR (preprint), PMC…
  pmid?: string;
  pmcid?: string;
  doi?: string;
  title: string;
  /** Comma-joined author string from Europe PMC (shown on expand). */
  authors: string;
  abstract: string;
  journal: string;
  journalNorm: string;
  date: string; // YYYY-MM-DD, index date (fallback publication date)
  isOpenAccess: boolean;
  isPreprint: boolean;
  /** Europe PMC's own flag that the paper has associated data (the reliable "has data"
   *  signal; text-mined accessions lag indexing and are often absent on fresh records). */
  hasData: boolean;
  /** ENA/BioProject study accessions found in title+abstract — what ENA import takes.
   *  Best-effort: present only when the accession appears in the abstract. */
  accessions: string[];
  /** Link to read: the DOI resolver, else Europe PMC. */
  url: string;
};

const SEARCH = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';
const FOCUS =
  '(metagenomic* OR microbiome OR metagenome OR "shotgun metagenomic*" OR "microbial community" OR metatranscriptom* OR "16S rRNA" OR "amplicon sequencing" OR metabarcoding)';
// ENA study (ERP/SRP/DRP) and BioProject (PRJNA/PRJEB/PRJDB) accessions.
const ACCESSION_RE = /\b(PRJ(?:NA|EB|DB)\d+|[EDS]RP\d{6,})\b/g;

const CACHE_TTL_MS = 60 * 60 * 1000; // an hour

/** A journal string reduced to a comparable key: lowercase, &→and, non-alphanumerics to
 *  spaces. Europe PMC uses ISO abbreviations ("Nat Microbiol"), so filters match loosely. */
export function normJournal(j: string): string {
  return j
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Europe PMC titles/abstracts carry inline formatting (<i>, <sup>, …). Render it
 *  safely: escape everything, then restore only a whitelist of BARE formatting tags —
 *  so no attributes, scripts, or other markup can survive (XSS-safe for `{@html}`). */
export function richText(s: string): string {
  const esc = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(/&lt;(\/?)(i|em|sup|sub|b|strong|u)&gt;/gi, '<$1$2>');
}

/** A journal filter chip: a label and a test over the normalized journal key. */
export type JournalFilter = { label: string; test: (norm: string) => boolean };

/** The default set, all on: the Nature sub-family plus a few microbiome/genomics venues.
 *  Tests are loose because Europe PMC abbreviates ("Nat Microbiol", "ISME J"). */
const nat = (kw: RegExp) => (n: string) => /^nat(ure)?\b/.test(n) && kw.test(n);
export const JOURNAL_FILTERS: JournalFilter[] = [
  // The Nature sub-family, split out (Europe PMC abbreviates: "Nat Microbiol" etc.).
  { label: 'Nature', test: (n) => n === 'nature' },
  { label: 'Nature Microbiology', test: nat(/microbiol/) },
  { label: 'Nature Communications', test: nat(/commun/) },
  { label: 'Nature Methods', test: nat(/method/) },
  { label: 'Nature Biotechnology', test: nat(/biotechnol/) },
  { label: 'Nature Genetics', test: nat(/genet/) },
  { label: 'Nature Medicine', test: nat(/\bmed(icine)?\b/) },
  { label: 'Nature Ecology & Evolution', test: nat(/ecol/) },
  // Other microbiome / genomics venues.
  { label: 'Microbiome', test: (n) => n === 'microbiome' },
  { label: 'Cell Host & Microbe', test: (n) => n.includes('cell host') },
  { label: 'Cell Genomics', test: (n) => n.includes('cell genom') },
  { label: 'Genome Biology', test: (n) => n.includes('genome biol') },
  { label: 'Genome Medicine', test: (n) => n.includes('genome med') },
  { label: 'mSystems', test: (n) => n.includes('msystem') },
  { label: 'ISME J', test: (n) => n.includes('isme') },
  { label: 'Nucleic Acids Research', test: (n) => n.includes('nucleic acids res') },
  { label: 'Gut', test: (n) => n === 'gut' }
];

type RawResult = Record<string, unknown>;

function parseItem(r: RawResult): Paper {
  const s = (k: string) => (r[k] == null ? undefined : String(r[k]));
  const source = s('source') ?? '';
  const title = (s('title') ?? '').replace(/\.$/, '');
  const abstract = s('abstractText') ?? '';
  // The journal is nested (journalInfo.journal.title); the top-level journalTitle is null
  // in core results. ISO/MEDLINE abbreviations are the fallback.
  const j = (r.journalInfo as { journal?: { title?: string; isoabbreviation?: string; medlineAbbreviation?: string } } | undefined)?.journal;
  const journal = j?.title || j?.isoabbreviation || j?.medlineAbbreviation || (source === 'PPR' ? 'Preprint' : '—');
  const doi = s('doi');
  const pmid = s('pmid');
  const accessions = [...new Set(`${title}\n${abstract}`.match(ACCESSION_RE) ?? [])];
  const url = doi
    ? `https://doi.org/${doi}`
    : pmid
      ? `https://europepmc.org/article/MED/${pmid}`
      : `https://europepmc.org/article/${source}/${s('id')}`;
  return {
    id: s('id') ?? '',
    source,
    pmid,
    pmcid: s('pmcid'),
    doi,
    title,
    authors: s('authorString') ?? '',
    abstract,
    journal,
    journalNorm: normJournal(journal),
    date: s('firstIndexDate') ?? s('firstPublicationDate') ?? '',
    isOpenAccess: r.isOpenAccess === 'Y',
    isPreprint: source === 'PPR',
    hasData: r.hasData === 'Y',
    accessions,
    url
  };
}

function readCache(key: string): Paper[] | null {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null') as { t: number; papers: Paper[] } | null;
    return v && Date.now() - v.t < CACHE_TTL_MS ? v.papers : null;
  } catch {
    return null;
  }
}
function writeCache(key: string, papers: Paper[]) {
  try {
    localStorage.setItem(key, JSON.stringify({ t: Date.now(), papers }));
  } catch {
    // storage full/unavailable: just skip caching
  }
}

/** Recent metagenomics papers, newest first. Cached per day-window for an hour. `force`
 *  skips the cache (the Refresh button). */
export async function fetchRecentPapers(days: number, force = false): Promise<Paper[]> {
  const to = new Date();
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const query = `${FOCUS} AND (FIRST_IDATE:[${iso(from)} TO ${iso(to)}])`;
  const key = scopedKey(`qiita-web:papers:v5:${days}:${iso(to)}`);
  if (!force) {
    const cached = readCache(key);
    if (cached) return cached;
  }
  const params = new URLSearchParams({
    query,
    format: 'json',
    resultType: 'core',
    // A window can hold thousands of hits; fetch Europe PMC's max page so client-side
    // journal/data filtering has real coverage (a 30-day window is ~5k, ~400 with data).
    pageSize: '1000',
    sort: 'FIRST_PDATE_D desc'
  });
  const res = await fetch(`${SEARCH}?${params}`);
  if (!res.ok) throw new Error(`Europe PMC HTTP ${res.status}`);
  const data = (await res.json()) as { resultList?: { result?: RawResult[] } };
  const papers = (data.resultList?.result ?? []).map(parseItem).filter((p) => p.title);
  papers.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // recency desc
  writeCache(key, papers);
  return papers;
}

// --- text-mined accessions (the real "importable" signal) --------------------
// The abstract rarely carries the PRJ/ERP; Europe PMC text-mines it from the full
// text. That lives behind a separate annotations API, batched (≤8 article ids/call),
// so it's fetched only for the papers actually shown. Cached per paper id for a week.

const ANNOTATIONS = 'https://www.ebi.ac.uk/europepmc/annotations_api/annotationsByArticleIds';
const ANNO_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type AnnArticle = { source?: string; extId?: string; annotations?: { exact?: string }[] };

function readAnno(id: string): string[] | null {
  try {
    const v = JSON.parse(localStorage.getItem(scopedKey(`qiita-web:anno:${id}`)) ?? 'null') as { t: number; a: string[] } | null;
    return v && Date.now() - v.t < ANNO_TTL_MS ? v.a : null;
  } catch {
    return null;
  }
}
function writeAnno(id: string, a: string[]) {
  try {
    localStorage.setItem(scopedKey(`qiita-web:anno:${id}`), JSON.stringify({ t: Date.now(), a }));
  } catch {
    // ignore
  }
}

/** ENA/BioProject study accessions text-mined from each paper's full text, keyed by
 *  paper id. Every requested id gets an entry (empty array when none), so the caller can
 *  mark it "checked". Cached; only uncached ids hit the network. */
export async function accessionsFor(papers: { source: string; id: string }[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  const todo: { source: string; id: string }[] = [];
  for (const p of papers) {
    const cached = readAnno(p.id);
    if (cached) out[p.id] = cached;
    else todo.push(p);
  }
  const batches: { source: string; id: string }[][] = [];
  for (let i = 0; i < todo.length; i += 8) batches.push(todo.slice(i, i + 8));
  await Promise.all(
    batches.map(async (batch) => {
      const params = batch.map((p) => `articleIds=${p.source}:${p.id}`).join('&');
      let data: AnnArticle[] = [];
      try {
        const res = await fetch(`${ANNOTATIONS}?${params}&type=Accession%20Numbers&format=JSON`);
        if (res.ok) data = (await res.json()) as AnnArticle[];
      } catch {
        data = [];
      }
      const byId = new Map<string, string[]>();
      for (const art of Array.isArray(data) ? data : []) {
        const accs = new Set<string>();
        for (const a of art.annotations ?? []) for (const m of (a.exact ?? '').match(ACCESSION_RE) ?? []) accs.add(m);
        if (art.extId) byId.set(String(art.extId), [...accs]);
      }
      for (const p of batch) {
        const accs = byId.get(p.id) ?? [];
        out[p.id] = accs;
        writeAnno(p.id, accs);
      }
    })
  );
  return out;
}
