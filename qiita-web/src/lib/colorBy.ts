// Colouring samples by one metadata variable, for an ordination plot: each
// sample's value, a colour per value (or per range, for a continuous number),
// a legend, and the grouping a PERMANOVA should test.
import type { MetaField } from './api';

export const MISSING_COLOR = '#d1d5db';
// Tableau 10, then its lighter companions: distinguishable up to 20 groups.
const PALETTE = [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac',
  '#a0cbe8', '#ffbe7d', '#ff9d9a', '#86bcb6', '#8cd17d', '#f1ce63', '#d4a6c8', '#fabfd2', '#d7b5a6', '#79706e'
];
/** Alphanumeric order: numbers by value inside text ("2" before "10"), case-insensitive. */
export const natural = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

// A continuous palette (viridis), sampled at t in [0, 1].
const GRADIENT = ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'];
export const GRADIENT_CSS = `linear-gradient(to right, ${GRADIENT.join(', ')})`;
function gradientAt(t: number): string {
  const x = Math.min(1, Math.max(0, t)) * (GRADIENT.length - 1);
  const i = Math.min(GRADIENT.length - 2, Math.floor(x));
  const f = x - i;
  const rgb = (h: string) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
  const [a, b] = [rgb(GRADIENT[i]), rgb(GRADIENT[i + 1])];
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(',')})`;
}

// A numeric variable with more distinct values than this is binned, not one
// colour per value.
const MAX_CATEGORIES = 12;
const BINS = 6;

/** A field's value as text, or null when absent or a missing-value marker. */
export function fieldValue(f: MetaField | undefined): string | null {
  if (!f || f.value == null) return null;
  const v = f.value;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.kind === 'missing_reason') return null;
    if (o.kind === 'terminology_term') return String(o.label ?? o.term_id);
    return JSON.stringify(v);
  }
  const s = String(v).trim();
  return s === '' ? null : s;
}

export type LegendEntry = { label: string; color: string; n: number };
export type Coloring = {
  kind: 'categorical' | 'continuous';
  colorOf: Record<string, string>;
  legend: LegendEntry[];
  /** Set for a numeric variable on the continuous palette: the bar's ends. */
  gradient?: { min: string; max: string };
  /** For PERMANOVA: sample -> group, null to leave out; null overall for a
   *  continuous variable, which has no groups to test. */
  groups: Record<string, string | null> | null;
};

/** Colour `values` (sample label -> value or null). Values run in alphanumeric
 *  order. `continuous` puts them on a gradient: a number by its value, text by
 *  its rank. Otherwise each value gets its own colour, except a number with
 *  many distinct values, which is binned. The PERMANOVA grouping depends on the
 *  data, not the palette: a many-valued number has none. */
export function colorBy(
  values: Record<string, string | null>,
  { continuous = false }: { continuous?: boolean } = {}
): Coloring {
  const present = Object.values(values).filter((v): v is string => v != null);
  const distinct = [...new Set(present)];
  const numeric = distinct.length > 0 && distinct.every((v) => Number.isFinite(Number(v)));
  const missingN = Object.values(values).filter((v) => v == null).length;
  const missing: LegendEntry[] = missingN ? [{ label: 'missing', color: MISSING_COLOR, n: missingN }] : [];
  const testable = !(numeric && distinct.length > MAX_CATEGORIES);
  const ordered = numeric ? [...distinct].sort((a, b) => Number(a) - Number(b)) : [...distinct].sort(natural);
  const countOf = (v: string) => present.filter((x) => x === v).length;

  if (continuous && distinct.length) {
    const colorOf: Record<string, string> = {};
    if (numeric) {
      const nums = distinct.map(Number);
      const lo = Math.min(...nums);
      const span = Math.max(...nums) - lo || 1;
      for (const [label, v] of Object.entries(values))
        colorOf[label] = v == null ? MISSING_COLOR : gradientAt((Number(v) - lo) / span);
      const fmt = (x: number) => (Math.abs(x) >= 100 ? Math.round(x).toLocaleString() : String(+x.toPrecision(3)));
      return {
        kind: 'continuous',
        colorOf,
        legend: missing,
        gradient: { min: fmt(lo), max: fmt(lo + span) },
        groups: testable ? values : null
      };
    }
    const at = new Map(ordered.map((v, i) => [v, gradientAt(ordered.length > 1 ? i / (ordered.length - 1) : 0.5)]));
    for (const [label, v] of Object.entries(values)) colorOf[label] = v == null ? MISSING_COLOR : at.get(v)!;
    const legend = ordered.map((v) => ({ label: v, color: at.get(v)!, n: countOf(v) }));
    return { kind: 'continuous', colorOf, legend: [...legend, ...missing], groups: values };
  }

  if (!testable) {
    const nums = present.map(Number);
    const lo = Math.min(...nums);
    const hi = Math.max(...nums);
    const step = (hi - lo) / BINS || 1;
    const binOf = (x: number) => Math.min(BINS - 1, Math.floor((x - lo) / step));
    // Sequential: light to dark teal.
    const ramp = ['#ccfbf1', '#99f6e4', '#5eead4', '#2dd4bf', '#0d9488', '#115e59'];
    const fmt = (x: number) => (Math.abs(x) >= 100 ? Math.round(x).toLocaleString() : x.toPrecision(3));
    const colorOf: Record<string, string> = {};
    const counts = new Array(BINS).fill(0);
    for (const [label, v] of Object.entries(values)) {
      if (v == null) colorOf[label] = MISSING_COLOR;
      else {
        const b = binOf(Number(v));
        counts[b]++;
        colorOf[label] = ramp[b];
      }
    }
    const legend = counts.map((n, b) => ({
      label: `${fmt(lo + b * step)} – ${fmt(lo + (b + 1) * step)}`,
      color: ramp[b],
      n
    }));
    return { kind: 'continuous', colorOf, legend: [...legend, ...missing], groups: null };
  }

  const colorFor = new Map(ordered.map((v, i) => [v, PALETTE[i % PALETTE.length]]));
  const colorOf: Record<string, string> = {};
  for (const [label, v] of Object.entries(values)) colorOf[label] = v == null ? MISSING_COLOR : colorFor.get(v)!;
  const legend = ordered.map((v) => ({
    label: v,
    color: colorFor.get(v)!,
    n: countOf(v)
  }));
  return { kind: 'categorical', colorOf, legend: [...legend, ...missing], groups: values };
}

// Marker shapes, for a second variable. Symbol names are SveltePlot's; the
// glyph stands in for each in a legend. Missing values take the last.
export const SHAPES: { symbol: string; glyph: string }[] = [
  { symbol: 'circle', glyph: '●' },
  { symbol: 'square', glyph: '■' },
  { symbol: 'triangle', glyph: '▲' },
  { symbol: 'diamond', glyph: '◆' },
  { symbol: 'star', glyph: '★' },
  { symbol: 'cross', glyph: '✚' }
];
const MISSING_SHAPE = { symbol: 'wye', glyph: 'Y' };

export type ShapeEntry = { label: string; symbol: string; glyph: string; n: number };
export type Shaping = { symbolOf: Record<string, string>; legend: ShapeEntry[]; repeats: boolean };

/** Shape `values` (sample label -> value or null) by category, in alphanumeric
 *  order; past six values the shapes repeat, which `repeats` says. */
export function shapeBy(values: Record<string, string | null>): Shaping {
  const present = Object.values(values).filter((v): v is string => v != null);
  const count = new Map<string, number>();
  for (const v of present) count.set(v, (count.get(v) ?? 0) + 1);
  const ordered = [...count.keys()].sort(natural);
  const shapeFor = new Map(ordered.map((v, i) => [v, SHAPES[i % SHAPES.length]]));
  const symbolOf: Record<string, string> = {};
  for (const [label, v] of Object.entries(values))
    symbolOf[label] = v == null ? MISSING_SHAPE.symbol : shapeFor.get(v)!.symbol;
  const legend: ShapeEntry[] = ordered.map((v) => ({ label: v, ...shapeFor.get(v)!, n: count.get(v)! }));
  const missingN = Object.values(values).length - present.length;
  if (missingN) legend.push({ label: 'missing', ...MISSING_SHAPE, n: missingN });
  return { symbolOf, legend, repeats: ordered.length > SHAPES.length };
}
