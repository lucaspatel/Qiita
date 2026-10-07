// Reading biosample metadata for display: one cell's text, the column set, and
// the geographic point a sample contributes to the map. Used by SampleGrid and
// the study page.
import type { Biosample } from './api';

export type Column = { key: string; label: string };
export type GeoPoint = { lat: number; lon: number; type: string; label: string };

/** A metadata cell as text; '' when the field is absent or null. */
export function cellText(s: Biosample, key: string): string {
  const f = s.global_metadata?.[key];
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

/** Union of metadata fields across samples, in first-seen order. */
export function metadataColumns(samples: Biosample[]): Column[] {
  const seen = new Map<string, string>();
  for (const s of samples)
    for (const [k, f] of Object.entries(s.global_metadata ?? {}))
      if (!seen.has(k)) seen.set(k, f.display_name || k);
  return [...seen.entries()].map(([key, label]) => ({ key, label }));
}

export function sampleLabel(s: Biosample): string {
  return s.biosample_accession ?? String(s.biosample_idx);
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
function geoVal(s: Biosample, kind: 'lat' | 'lon'): number | null {
  const re = kind === 'lat' ? /\b(lat|latitude)\b/ : /\b(lon|lng|long|longitude)\b/;
  for (const [k, f] of Object.entries(s.global_metadata ?? {})) {
    if (re.test(k.toLowerCase().replace(/[_-]+/g, ' '))) {
      const n = num(f?.value);
      if (n != null) return n;
    }
  }
  return null;
}

/** The samples' map points; samples without both coordinates are skipped. */
export function geoPoints(samples: Biosample[]): GeoPoint[] {
  return samples.flatMap((s) => {
    const lat = geoVal(s, 'lat');
    const lon = geoVal(s, 'lon');
    return lat != null && lon != null ? [{ lat, lon, type: sampleType(s), label: sampleLabel(s) }] : [];
  });
}
