// What the active control plane says it is (GET /deployment), fetched once per
// page load. The badge trusts this over the client-side environment name: the
// server's answer is the one that can't be misconfigured on this side.
import { api } from './api';
import { current } from './environment';

export type DeploymentState =
  | { status: 'loading' }
  | { status: 'named'; name: string }
  | { status: 'unnamed' }
  // An older server without the route, or one that is unreachable.
  | { status: 'unknown'; detail: string };

export const deployment = $state<{ value: DeploymentState }>({ value: { status: 'loading' } });

if (typeof window !== 'undefined') {
  api.deployment().then((r) => {
    deployment.value = !r.ok
      ? { status: 'unknown', detail: r.status === 0 ? r.detail : `HTTP ${r.status}` }
      : r.data.name
        ? { status: 'named', name: r.data.name }
        : { status: 'unnamed' };
  });
}

/** The label to show: the server's name, else the dev environment's, else the host. */
export function displayName(d: DeploymentState): string {
  if (d.status === 'named') return d.name;
  return current?.name ?? location.host;
}

/** Production gets the quiet styling; anything else is flagged. */
export function isProduction(d: DeploymentState): boolean {
  return displayName(d) === 'prod';
}
