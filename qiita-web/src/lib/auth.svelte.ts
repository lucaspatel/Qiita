// The PAT the SPA sends as `Authorization: Bearer …`. Kept in localStorage so a
// refresh survives; exposed as a rune so components react when it changes.
// (SPA only — this module never runs under SSR, so `localStorage` is safe.)
// One token per environment: it is only ever sent to the server that minted it.
import { scopedKey } from './environment';

const TOKEN_KEY = 'qiita_token';
const KEY = scopedKey(TOKEN_KEY);

function createAuth() {
  let token = $state(typeof localStorage !== 'undefined' ? (localStorage.getItem(KEY) ?? '') : '');
  return {
    get token() {
      return token;
    },
    get isSet() {
      return token.length > 0;
    },
    set(t: string) {
      token = t.trim();
      localStorage.setItem(KEY, token);
    },
    clear() {
      token = '';
      localStorage.removeItem(KEY);
    }
  };
}

export const auth = createAuth();

/** Whether a token is stored for the named environment (for the env picker). */
export function hasTokenFor(envName: string): boolean {
  try {
    return !!localStorage.getItem(scopedKey(TOKEN_KEY, envName));
  } catch {
    return false;
  }
}
