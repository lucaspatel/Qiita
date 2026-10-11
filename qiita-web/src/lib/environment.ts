// Which control plane the SPA talks to. In `npm run dev` there may be several
// (see vite.config.ts); a production build has exactly one — its own origin —
// and `envs` is empty.
//
// Everything that belongs to one control plane is keyed by environment: the
// token (a token is only ever sent to the server it was minted on) and the
// recent-studies list (idx 5 on dev is not idx 5 on prod). Switching reloads
// the page, so no in-memory result from the old environment survives.
export type DevEnv = { name: string; origin: string };

const KEY = 'qiita-web:env';

export const envs: DevEnv[] = __QIITA_DEV_ENVS__;
export const switchable = envs.length > 1;

function initial(): DevEnv | null {
  if (envs.length === 0) return null;
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
  return (
    envs.find((e) => e.name === saved) ??
    envs.find((e) => e.name === __QIITA_DEV_DEFAULT_ENV__) ??
    envs[0]
  );
}

/** The active dev environment, or null in a production build. */
export const current: DevEnv | null = initial();

/** Prefix for every API call: the env's proxy route in dev, same-origin in prod. */
export const apiBase = current ? `/_env/${current.name}/api/v1` : '/api/v1';

/** The real control-plane origin, for the full-page login redirect. */
export const cpOrigin: string =
  current?.origin ??
  (import.meta.env.VITE_QIITA_BASE as string | undefined) ??
  'https://qiita-miint.ucsd.edu';

/** Namespace a localStorage key by environment (unchanged in a production build). */
export function scopedKey(key: string, envName: string | undefined = current?.name): string {
  return envName ? `${key}:${envName}` : key;
}

export function switchTo(name: string): void {
  if (!envs.some((e) => e.name === name) || name === current?.name) return;
  localStorage.setItem(KEY, name);
  location.reload();
}

/**
 * The token the qiita CLI stored for an environment, via the dev server's
 * `/_qiita/cli-token` route (see vite.config.ts). Dev builds only.
 */
export async function fetchCliToken(
  name: string
): Promise<{ ok: true; token: string } | { ok: false; detail: string }> {
  try {
    const res = await fetch(`/_qiita/cli-token?env=${encodeURIComponent(name)}`, {
      headers: { 'X-Qiita-Dev': '1' }
    });
    const body = (await res.json().catch(() => ({}))) as { token?: string; detail?: string };
    return res.ok && body.token
      ? { ok: true, token: body.token }
      : { ok: false, detail: body.detail ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}

/** Whether the qiita CLI has a stored token for an environment (without reading it). */
export async function cliTokenExists(name: string): Promise<boolean> {
  try {
    const res = await fetch(`/_qiita/cli-token?env=${encodeURIComponent(name)}&exists=1`, {
      headers: { 'X-Qiita-Dev': '1' }
    });
    return res.ok && ((await res.json()) as { exists?: boolean }).exists === true;
  } catch {
    return false;
  }
}
