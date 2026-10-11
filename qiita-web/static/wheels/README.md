# Wheels for the Pyodide worker

Everything the worker installs beyond the Pyodide distribution, at pinned versions.
`PACKAGE_SETS` in `src/lib/pyodide/config.ts` says which analysis installs which.
The worker passes these URLs straight to `pyodide.loadPackage`, which installs a
wheel without resolving its requirements, so each set lists every requirement
itself, from the Pyodide distribution or from here.

| Wheel | Source |
|---|---|
| `metameq`, `cerberus`, `openpyxl`, `et_xmlfile`, `array_api_compat` | PyPI, pure Python (`pip download --no-deps --only-binary=:all: <name>==<version>`) |
| `scikit_bio`, `biom_format` | built for Pyodide 0.29 (Emscripten 4.0.9), test suites stripped; see the skbio-wasm build notes |

## Bumping a version

1. Download the new wheel here and delete the old one, then update its URL in `PACKAGE_SETS`.
2. Check its requirements are still covered:
   `unzip -p <wheel> '*.dist-info/METADATA' | grep ^Requires-Dist`.
   Each one must be in the set's `pyodide` list (a Pyodide package name) or be
   another wheel in the set.
3. Re-run the validation and PCoA in the browser: a missing requirement shows up
   as an `ImportError` from the worker.

The filenames carry the version, so a server can cache them as immutable.
