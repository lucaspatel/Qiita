// The open study's biosamples, metadata included, loaded once when the study
// opens and shared by everything on the page that needs it: the Samples tab, and
// the lineage plots that colour samples by metadata.
//
// There is no bulk metadata read, so this is one list call and one study-scoped
// read per biosample (the study-scoped one, since only it carries the study's
// own fields), CONC at a time. Batches stream in, so a caller can show progress.
// Reads are cached per study, so returning to a study fetches only what is new.
import { api, type Biosample } from './api';

const CONC = 12;

class StudyMetadata {
  /** The study loaded, or loading; null before the first. */
  studyIdx = $state<number | null>(null);
  loading = $state(false);
  /** How many biosamples the study links (known once the list call returns). */
  total = $state(0);
  error = $state('');
  // Raw: replaced per batch, never mutated; deep-proxying ~1k samples is slow.
  samples = $state.raw<Biosample[]>([]);
  readonly byIdx = $derived(new Map(this.samples.map((b) => [b.biosample_idx, b])));

  #seq = 0;
  // Keyed `${study_idx}:${biosample_idx}`: a biosample's local_metadata is per study.
  #cache = new Map<string, Biosample>();

  /** Whether `studyIdx` is fully loaded. */
  ready(studyIdx: number): boolean {
    return this.studyIdx === studyIdx && !this.loading && !this.error;
  }

  /** Load `studyIdx`'s biosamples, unless it is already loaded or loading.
   *  `force` re-lists (after samples are added) and fetches what is new.
   *  Resolves to whether the study's samples could be listed. */
  async load(studyIdx: number, { force = false } = {}): Promise<boolean> {
    if (!force && this.studyIdx === studyIdx && (this.loading || !this.error)) return !this.error;
    const seq = ++this.#seq;
    this.studyIdx = studyIdx;
    this.loading = true;
    this.error = '';
    this.samples = [];
    const list = await api.biosampleIdxs(studyIdx);
    if (seq !== this.#seq) return false;
    if (!list.ok) {
      this.error = `samples: HTTP ${list.status} — ${list.detail}`;
      this.total = 0;
      this.loading = false;
      return false;
    }
    const idxs = list.data.idxs;
    this.total = idxs.length;
    const key = (x: number) => `${studyIdx}:${x}`;
    this.samples = idxs.flatMap((x) => this.#cache.get(key(x)) ?? []);
    const missing = idxs.filter((x) => !this.#cache.has(key(x)));
    for (let k = 0; k < missing.length; k += CONC) {
      const rs = await Promise.all(
        missing.slice(k, k + CONC).map((x) => api.studyBiosample(studyIdx, x))
      );
      if (seq !== this.#seq) return false;
      const got = rs.flatMap((r) => (r.ok ? [r.data] : []));
      for (const b of got) this.#cache.set(key(b.biosample_idx), b);
      this.samples = [...this.samples, ...got];
    }
    this.loading = false;
    return true;
  }
}

export const studyMetadata = new StudyMetadata();
