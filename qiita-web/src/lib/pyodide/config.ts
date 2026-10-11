/**
 * Pyodide configuration - CDN URLs and package dependencies
 */

// Pyodide CDN configuration
// 0.29.x: scikit-bio 0.7 needs numpy 2, which 0.26 does not ship. The skbio
// wheels below are built for this release's ABI and must be rebuilt with it.
export const PYODIDE_CDN_URL = 'https://cdn.jsdelivr.net/pyodide/v0.29.5/full/';

// What each analysis needs on top of the Pyodide core, installed by the worker the
// first time that analysis runs (so a PCoA never waits for metameq, nor a
// validation for scikit-bio). `pyodide` names come from this release's own
// distribution; `wheels` are served from static/wheels/ at pinned versions and
// installed as-is, with no dependency resolution: nothing is fetched from PyPI,
// and a new upstream release cannot change results until it is pinned here.
// Every requirement of a wheel must appear in its set (static/wheels/README.md
// says how to check). scikit-bio and biom-format have no PyPI wheel for
// WebAssembly; they are our build and must be rebuilt when Pyodide's ABI changes.
export const PACKAGE_SETS = {
  validation: {
    pyodide: ['pandas', 'pyyaml', 'python-dateutil', 'click'],
    wheels: [
      '/wheels/cerberus-1.3.8-py3-none-any.whl',
      '/wheels/et_xmlfile-2.0.0-py3-none-any.whl',
      '/wheels/openpyxl-3.1.5-py2.py3-none-any.whl',
      '/wheels/metameq-2026.3.1-py3-none-any.whl'
    ],
    code: ['/validation.py', '/metadata_review.py']
  },
  ordination: {
    // skbio.metadata imports sqlite3, a separate Pyodide package.
    pyodide: ['numpy', 'scipy', 'pandas', 'h5py', 'statsmodels', 'patsy', 'requests', 'decorator', 'click', 'sqlite3'],
    wheels: [
      '/wheels/array_api_compat-1.15.0-py3-none-any.whl',
      '/wheels/biom_format-2.1.18-cp313-cp313-pyemscripten_2025_0_wasm32.whl',
      '/wheels/scikit_bio-0.7.4-cp313-cp313-pyemscripten_2025_0_wasm32.whl'
    ],
    code: ['/ordination.py']
  }
} as const;

export type PackageSet = keyof typeof PACKAGE_SETS;

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
