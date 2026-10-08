import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge conditional Tailwind classes (used by our copied kit components). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Field-key → display label: "geographic_location_latitude" / "host taxon id"
 * → "Geographic Location Latitude" / "Host Taxon Id". Leaves an already-pretty
 * label mostly intact (just title-cases the first letters).
 */
export function humanize(s: string): string {
  return s
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Tokens humanize() title-cases that should read as acronyms/words instead.
const ACRONYMS: Record<string, string> = {
  Ena: 'ENA',
  Ncbi: 'NCBI',
  Pi: 'PI',
  Id: 'ID',
  Idx: 'Index',
  Url: 'URL',
  Doi: 'DOI'
};

/** humanize() with acronym fixups: "ena_study_accession" → "ENA Study Accession". */
export function humanizeLabel(s: string): string {
  return humanize(s)
    .split(' ')
    .map((w) => ACRONYMS[w] ?? w)
    .join(' ');
}

/** A timestamp for display: "12 Jul 2026 (2 months ago)". Returns the raw input
 *  if unparseable, '' for null/empty. */
export function fmtDate(iso: unknown): string {
  if (iso == null || iso === '') return '';
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return String(iso);
  const abs = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  return `${abs} (${relativeTime(d)})`;
}

function relativeTime(d: Date): string {
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const diffSec = (d.getTime() - Date.now()) / 1000;
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
    ['second', 1]
  ];
  for (const [unit, secs] of steps) {
    if (Math.abs(diffSec) >= secs || unit === 'second') return rtf.format(Math.round(diffSec / secs), unit);
  }
  return '';
}
