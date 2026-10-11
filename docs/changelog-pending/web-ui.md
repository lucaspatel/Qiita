### Added

- **Named environments for the CLI and web UI, with tokens bound to their deployment.**
  `qiita env add/use/list/remove` keeps named control planes (prod, a dev stack) in
  `~/.qiita/config.toml`, each with its own token under `~/.qiita/tokens/`; every command
  takes `--env NAME` / `$QIITA_ENV`. A stored token is only sent to the environment it
  belongs to — before, re-pointing `$QIITA_CONTROL_PLANE_URL` sent the one `~/.qiita/token`
  to whatever server it named. With no config file the CLI behaves as before. The control
  plane serves its operator-set name (`QIITA_DEPLOYMENT_NAME`) at the unauthenticated
  `GET /api/v1/deployment`; `qiita whoami` prints it on stderr. In `npm run dev`, qiita-web
  reads the same config, proxies each environment at `/_env/<name>/api`, keeps tokens and
  recent studies per environment, shows the server-reported name as a top-bar badge, and
  switches environments from `/profile`.
- **qiita-web, a browser UI over the control plane (work in progress).** A SvelteKit SPA under
  `qiita-web/`: study list and detail (records, samples with their full metadata, pools, a
  processing lineage graph with plots of the amplicon feature table, PCoA and PERMANOVA on
  scikit-bio in a Pyodide worker), Add Samples with a metameq review loop, and the ENA import.
