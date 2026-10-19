// Reading biosample metadata for display: one cell's text, the column set, and
// the geographic point a sample contributes to the map. Used by SampleGrid and
// the study page.
import type { Biosample, MetaField } from '$lib/api';

/** `global`: a field every study shares; `local`: one of this study's own. */
export type Column = { key: string; label: string; scope: 'global' | 'local' };
export type GeoPoint = { lat: number; lon: number; type: string; label: string };

// Built once per sample: a grid reads every cell of every sample to filter and sort.
const fieldsCache = new WeakMap<Biosample, Record<string, MetaField>>();

/** Every metadata field a sample carries, global and study-local, keyed for
 * lookup. A study-local key that a global field also uses is prefixed so
 * neither hides the other. */
export function metadataFields(s: Biosample): Record<string, MetaField> {
  let out = fieldsCache.get(s);
  if (!out) {
    out = { ...(s.global_metadata ?? {}) };
    for (const [k, f] of Object.entries(s.local_metadata ?? {})) out[k in out ? `local:${k}` : k] = f;
    fieldsCache.set(s, out);
  }
  return out;
}

/** A metadata cell as text; '' when the field is absent or null. */
export function cellText(s: Biosample, key: string): string {
  const f = metadataFields(s)[key];
  if (!f || f.value == null) return '';
  const v = f.value;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.kind === 'missing_reason') return String(o.name ?? '(missing)');
    if (o.kind === 'terminology_term') return String(o.label ?? o.term_id ?? '(term)');
    return JSON.stringify(v);
  }
  return String(v);
}

/** Union of metadata fields across samples, global fields first, each in
 * first-seen order. */
export function metadataColumns(samples: Biosample[]): Column[] {
  const seen = new Map<string, Column>();
  for (const s of samples) {
    const globals = s.global_metadata ?? {};
    for (const k of Object.keys(metadataFields(s)))
      if (!seen.has(k))
        // A global field's key is its snake_case internal_name; a local field's is
        // the sheet's own header. Either reads as written; humanizing is the
        // client's choice.
        seen.set(k, { key: k, label: k.replace(/^local:/, ''), scope: k in globals ? 'global' : 'local' });
  }
  const cols = [...seen.values()];
  return [...cols.filter((c) => c.scope === 'global'), ...cols.filter((c) => c.scope === 'local')];
}

// The sample's public name: a deposited accession, else Qiita's own QB. Never
// the internal biosample_idx.
export function sampleLabel(s: Biosample): string {
  return s.biosample_accession ?? s.ena_sample_accession ?? s.export_entity_id;
}

/** Where a sample's public label comes from. */
export type LabelSource = 'biosample_accession' | 'ena_sample_accession' | 'export_entity_id';

const LABEL_SOURCE_NAME: Record<LabelSource, string> = {
  biosample_accession: 'BioSample accession',
  ena_sample_accession: 'ENA sample accession',
  export_entity_id: 'Qiita ID (QB)'
};

/** The header for a column of sample labels: what they are when they all come
 * from the same place. */
export function labelHeader(sources: Iterable<LabelSource>): string {
  const set = new Set(sources);
  return set.size === 1 ? LABEL_SOURCE_NAME[[...set][0]] : 'Accession / Qiita ID';
}

export function sampleLabelHeader(samples: Biosample[]): string {
  return labelHeader(
    samples.map((s): LabelSource =>
      s.biosample_accession
        ? 'biosample_accession'
        : s.ena_sample_accession
          ? 'ena_sample_accession'
          : 'export_entity_id'
    )
  );
}

// --- the pinned identity column: which handle names each row ------------------
// The biosample read exposes three stable handles (accessions + the Qiita ID); a
// `sample_name` is the study's own metadata field, not a read-level field, so it is
// resolved from metadata. The owner's original submitted name is PII (admin-export
// only) and is deliberately not an option here.
export type IdentitySource = 'biosample_accession' | 'ena_sample_accession' | 'export_entity_id' | 'sample_name';

export const IDENTITY_LABEL: Record<IdentitySource, string> = {
  biosample_accession: 'BioSample accession',
  ena_sample_accession: 'ENA accession',
  export_entity_id: 'Qiita ID (QB)',
  sample_name: 'Sample name'
};

/** A sample's chosen identity handle, '' when it has none of that kind. */
export function sampleIdentity(s: Biosample, source: IdentitySource): string {
  switch (source) {
    case 'biosample_accession':
      return s.biosample_accession ?? '';
    case 'ena_sample_accession':
      return s.ena_sample_accession ?? '';
    case 'export_entity_id':
      return s.export_entity_id;
    case 'sample_name':
      return cellText(s, 'sample_name') || cellText(s, 'local:sample_name');
  }
}

/** Identity sources that resolve for at least one of these samples — so the toggle
 *  offers only handles the data actually carries (Qiita ID is always present). */
export function availableIdentities(samples: Biosample[]): IdentitySource[] {
  const all: IdentitySource[] = ['biosample_accession', 'ena_sample_accession', 'export_entity_id', 'sample_name'];
  return all.filter((src) => src === 'export_entity_id' || samples.some((s) => sampleIdentity(s, src)));
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

// qiita_sample_type is the controlled vocab that's reliable across studies —
// use only its terminology-term label; anything else is 'unspecified'.
function sampleType(s: Biosample): string {
  const v = s.global_metadata?.qiita_sample_type?.value;
  if (v && typeof v === 'object' && (v as { kind?: string }).kind === 'terminology_term') {
    return String((v as { label?: string }).label ?? 'unspecified');
  }
  return 'unspecified';
}

// Lat/long column names vary across sheets ("latitude",
// "geographic_location_latitude", "lat", …), so match by word rather than one
// canonical key — otherwise an uploaded sheet's coordinates never reach the map.
const LAT_RE = /\b(lat|latitude)\b/;
const LON_RE = /\b(lon|lng|long|longitude)\b/;

/** A sample's lat/lon, resolved in one metadata pass. */
function geoLatLon(s: Biosample): { lat: number | null; lon: number | null } {
  let lat: number | null = null;
  let lon: number | null = null;
  for (const [k, f] of Object.entries(metadataFields(s))) {
    const key = k.toLowerCase().replace(/[_-]+/g, ' ');
    if (lat == null && LAT_RE.test(key)) lat = num(f?.value);
    else if (lon == null && LON_RE.test(key)) lon = num(f?.value);
    if (lat != null && lon != null) break;
  }
  return { lat, lon };
}

/** A sample's map point, or null if it lacks either coordinate. */
export function geoPoint(s: Biosample): GeoPoint | null {
  const { lat, lon } = geoLatLon(s);
  return lat != null && lon != null ? { lat, lon, type: sampleType(s), label: sampleLabel(s) } : null;
}

/** The samples' map points; samples without both coordinates are skipped. */
export function geoPoints(samples: Biosample[]): GeoPoint[] {
  return samples.flatMap((s) => geoPoint(s) ?? []);
}
