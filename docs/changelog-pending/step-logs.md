### Added

- **Every workflow step writes a readable step log.** A step's stderr is a few
  timestamped `<LEVEL> <step>: …` lines (settings, what each stage kept or dropped,
  timings), and its stdout is one JSON receipt — `{"kind": "completed", "step_name",
  "summary": {…}}`, or the no-data / failure kind with a `reason`. Control-plane
  `action:` steps, which previously wrote no logs at all, now write both files too, and
  the amplicon denoise and load steps narrate each filter stage.
