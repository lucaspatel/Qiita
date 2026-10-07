/**
 * Pyodide configuration - CDN URLs and package dependencies
 */

// Pyodide CDN configuration
export const PYODIDE_CDN_URL = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';

// Packages to install via micropip (from PyPI, always fetched fresh)
export const MICROPIP_PACKAGES = [
  'cerberus',
  'metameq',
];

// Built-in packages to load (already included in Pyodide)
export const BUILTIN_PACKAGES = [
  'pandas',
  'micropip',
];

// Config presets - maps preset names to public YAML file paths
export const CONFIG_PRESETS = {
  default: '/metameq_flattened.yml',
  abtx: '/abtx_metameq_flattened.yml',
} as const;

export type ConfigPreset = keyof typeof CONFIG_PRESETS;

// File size warning threshold (10MB)
export const FILE_SIZE_WARNING_BYTES = 10 * 1024 * 1024;

// Supported file extensions for METAMEQ
export const SUPPORTED_EXTENSIONS = ['.csv', '.tsv', '.xlsx', '.txt'];
