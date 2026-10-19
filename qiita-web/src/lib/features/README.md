# Features

Domain logic, one folder per feature of the app: `library-prep/` and `metadata/` so
far. The rest of `src/lib` moves here feature by feature.

```
src/lib/
  ui/          components that know no feature (Sheet, ProblemList, Tabs, DataTable, PlateMap…)
  table/       the table model: TSV in and out, column rules, edits, problems
  plate.ts     microplate geometry
  api.ts       the API client
  features/
    <feature>/
      *.ts         pure TypeScript: state, derivation, validation, routing, persistence
      <part>/      the same, for a feature with several parts (library-prep/amplicon)
      *.svelte     components that belong to this feature (SampleGrid, SampleUploader)
      mock/        stand-ins for what the server will answer, until it does
      *.test.ts    unit tests, beside what they test
```

## Rules

- **Logic is plain TypeScript with no Svelte in it.** A page holds the state
  (`$state`) and derives what it shows by calling the feature (`$derived(...)`); the
  feature never reads a rune, the DOM or storage. That is what lets a test call the
  same function the page does, in node, in milliseconds.
- **One state object per workflow.** A feature's state is one typed object (for
  example `AmpliconPrep`), so saving a draft saves all of it and restoring checks all
  of it (`persist.ts`). A field kept in a loose page variable is a field a draft forgets.
- **`ui/` never imports from `features/`.** A component in `ui/` takes plain data and
  calls back with plain edits (`CellEdit`); the feature decides what an edit means. A
  component that only one feature uses lives in that feature's folder. (`StudyLineage`
  is still in `ui/` until the lineage explorer gets its own folder.)
- **Mock data stays in `mock/`.** Logic takes what the mock provides as a parameter
  (a registry, a barcode lookup), so swapping the mock for the API changes the caller,
  not the logic.

## Tests

- `npm test`: unit tests (Vitest, node). Include property tests (fast-check) for any
  logic that must hold for every input, not just the examples: round trips, undo,
  "loading what was downloaded changes nothing".
- `npm run test:e2e`: whole workflows in a browser (Playwright, `tests/e2e/`), against
  a dev server whose API calls are all answered by the test. Every e2e test also fails
  on any uncaught page error.

A bug fixed is a test added: write the test that fails first, then the fix.
