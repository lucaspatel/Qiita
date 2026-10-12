// The last plot settings chosen on a study's lineage — colour and shape
// variables, the continuous palette, each plot's rarefaction depth — kept in this
// browser so a return visit picks up where it left off.
//
// A convenience, never state that matters: storage can be absent or throw
// (private windows, blocked site data), and a saved value can stop fitting the
// data (a variable removed, a depth no sample has any more). Every read and write
// is guarded; anything malformed is dropped and the defaults apply. Callers still
// check each value against the data before using it.

export type PlotPrefs = {
  colorVar?: string;
  shapeVar?: string;
  continuous?: boolean;
  /** The PCoA's rarefaction depth; null for relative abundance. */
  pcoaDepth?: number | null;
  /** The ASVs scatter's depth line; null for none. */
  asvDepth?: number | null;
  /** The scatter's axis scales: log when true, linear from zero when false. */
  xLog?: boolean;
  yLog?: boolean;
};

const key = (studyIdx: number, protocol: string) => `qiita-web:plot-prefs:${studyIdx}:${protocol}`;

const isDepth = (v: unknown) => v === null || (typeof v === 'number' && Number.isInteger(v) && v > 0);

/** The saved settings, keeping only well-formed values; {} when there are none,
 *  storage is unavailable, or the entry is malformed (which also clears it). */
export function loadPlotPrefs(studyIdx: number, protocol: string): PlotPrefs {
  try {
    const raw = localStorage.getItem(key(studyIdx, protocol));
    if (!raw) return {};
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    const o = v as Record<string, unknown>;
    const out: PlotPrefs = {};
    if (typeof o.colorVar === 'string') out.colorVar = o.colorVar;
    if (typeof o.shapeVar === 'string') out.shapeVar = o.shapeVar;
    if (typeof o.continuous === 'boolean') out.continuous = o.continuous;
    if ('pcoaDepth' in o && isDepth(o.pcoaDepth)) out.pcoaDepth = o.pcoaDepth as number | null;
    if ('asvDepth' in o && isDepth(o.asvDepth)) out.asvDepth = o.asvDepth as number | null;
    if (typeof o.xLog === 'boolean') out.xLog = o.xLog;
    if (typeof o.yLog === 'boolean') out.yLog = o.yLog;
    return out;
  } catch {
    clearPlotPrefs(studyIdx, protocol);
    return {};
  }
}

/** Merge `patch` into the saved settings. Silently does nothing without storage. */
export function savePlotPrefs(studyIdx: number, protocol: string, patch: PlotPrefs): void {
  try {
    const next = { ...loadPlotPrefs(studyIdx, protocol), ...patch };
    localStorage.setItem(key(studyIdx, protocol), JSON.stringify(next));
  } catch {
    // Storage unavailable or full: the settings just won't be remembered.
  }
}

export function clearPlotPrefs(studyIdx: number, protocol: string): void {
  try {
    localStorage.removeItem(key(studyIdx, protocol));
  } catch {
    // Nothing to clear.
  }
}
