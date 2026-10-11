### Changed

- **`amplicon` 1.1.0 takes only the trim length and the SortMeRNA reference.** The
  `primer` and `orient_primer` knobs are gone, along with the denoise step's
  primer-orient path: Rapid 16S's EMP-style preps never sequence the primer, so
  the step never needed it (it was off by default, and dropped reads containing
  an `N` when on). A context naming either knob is now refused. 1.0.0 stays on
  disk for provenance and is auto-deprecated by the next sync, after which an
  unfinished 1.0.0 ticket cannot run and is resubmitted as 1.1.0. Orienting for
  protocols that need it is left to protocol-driven primer handling, tracked in
  #609.
