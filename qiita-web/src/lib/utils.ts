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
