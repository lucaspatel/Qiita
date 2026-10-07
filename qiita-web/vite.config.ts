import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { parse } from 'smol-toml';
import { defineConfig, type Plugin, type ProxyOptions } from 'vite';

// Dev-server environments. The browser can't call a control plane directly
// (no CORS), so each environment gets a same-origin proxy prefix,
// `/_env/<name>/api` → `<base_url>/api`, and the SPA picks which prefix to
// call. The list is the CLI's own `~/.qiita/config.toml` (`qiita env add`),
// so the CLI and the UI agree on what "dev" means. `QIITA_BASE`, if it names
// a URL no environment claims, is added as `custom`; with neither, the
// default is production. A production build gets none of this: it is served
// beside its control plane and calls `/api/v1` on its own origin.
type DevEnv = { name: string; origin: string };

const DEFAULT_ORIGIN = 'https://qiita-miint.ucsd.edu';

const CONFIG_PATH = process.env.QIITA_CONFIG || join(homedir(), '.qiita', 'config.toml');

function loadEnvironments(): { envs: DevEnv[]; current: string } {
  const path = CONFIG_PATH;
  const envs: DevEnv[] = [];
  let current = '';
  if (existsSync(path)) {
    const raw = parse(readFileSync(path, 'utf8')) as {
      current?: string;
      env?: Record<string, { base_url: string }>;
    };
    for (const [name, table] of Object.entries(raw.env ?? {})) {
      envs.push({ name, origin: table.base_url.replace(/\/+$/, '') });
    }
    current = raw.current ?? '';
  }
  const base = process.env.QIITA_BASE?.replace(/\/+$/, '');
  if (base && !envs.some((e) => e.origin === base)) envs.push({ name: 'custom', origin: base });
  if (base) current = envs.find((e) => e.origin === base)!.name;
  if (envs.length === 0) envs.push({ name: 'prod', origin: DEFAULT_ORIGIN });
  if (!envs.some((e) => e.name === current)) current = envs[0].name;
  return { envs, current };
}

// `GET /_qiita/cli-token?env=<name>[&exists=1]` hands the page the token the CLI stored for
// that environment (`~/.qiita/tokens/<name>`, written by `qiita login` / `env
// add --adopt-token`), so a dev session needn't paste it. Dev server only. It
// answers just a same-origin fetch carrying `X-Qiita-Dev`: another site's page
// can't send that header without a CORS preflight, which this route never
// grants. Vite 5 does not check the Host header, so this route does: a
// loopback Host only, which defeats DNS rebinding (an attacker's name resolving
// to 127.0.0.1 still arrives with the attacker's Host). It never proxies the
// token anywhere; the SPA stores it like a pasted one.
const CLI_TOKEN_PATH = '/_qiita/cli-token';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function cliTokenPlugin(envs: DevEnv[]): Plugin {
  const tokenDir = join(dirname(CONFIG_PATH), 'tokens');
  return {
    name: 'qiita-cli-token',
    configureServer(server) {
      server.middlewares.use(CLI_TOKEN_PATH, (req, res) => {
        const send = (status: number, body: object) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(body));
        };
        const host = (req.headers.host ?? '').replace(/:\d+$/, '');
        if (
          !LOOPBACK_HOSTS.has(host) ||
          req.method !== 'GET' ||
          req.headers['x-qiita-dev'] !== '1' ||
          req.headers['sec-fetch-site'] !== 'same-origin'
        ) {
          return send(403, { detail: 'loopback, same-origin fetch with X-Qiita-Dev only' });
        }
        const params = new URL(req.url ?? '', 'http://local').searchParams;
        const name = params.get('env') ?? '';
        if (!envs.some((e) => e.name === name)) return send(404, { detail: `no environment ${name}` });
        const file = join(tokenDir, name);
        // `&exists=1` answers availability without the token, for greying out the button.
        if (params.get('exists') === '1') return send(200, { exists: existsSync(file) });
        if (!existsSync(file)) return send(404, { detail: `no CLI token at ${file}` });
        return send(200, { token: readFileSync(file, 'utf8').trim() });
      });
    }
  };
}

export default defineConfig(({ command }) => {
  const dev = command === 'serve' ? loadEnvironments() : { envs: [], current: '' };
  const proxy: Record<string, ProxyOptions> = {};
  for (const env of dev.envs) {
    const prefix = `/_env/${env.name}`;
    proxy[`${prefix}/api`] = {
      target: env.origin,
      changeOrigin: true,
      secure: true,
      rewrite: (p) => p.slice(prefix.length)
    };
  }
  return {
    plugins: [tailwindcss(), sveltekit(), ...(command === 'serve' ? [cliTokenPlugin(dev.envs)] : [])],
    define: {
      __QIITA_DEV_ENVS__: JSON.stringify(dev.envs),
      __QIITA_DEV_DEFAULT_ENV__: JSON.stringify(dev.current)
    },
    server: { proxy }
  };
});
