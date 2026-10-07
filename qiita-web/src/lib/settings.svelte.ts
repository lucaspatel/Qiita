// Client-side UI preferences, persisted to localStorage. Purely cosmetic /
// behavioral — nothing here touches the API. Toggled from the Settings page.
const KEY = 'qiita-web:settings';

export type Settings = {
  /** Title-case metadata field labels ("host_taxon_id" → "Host Taxon Id"). */
  humanizeLabels: boolean;
  /** Record visited/created studies under "Recent studies". */
  rememberRecents: boolean;
};

const defaults: Settings = { humanizeLabels: true, rememberRecents: true };

function load(): Settings {
  if (typeof localStorage === 'undefined') return { ...defaults };
  try {
    return { ...defaults, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>) };
  } catch {
    return { ...defaults };
  }
}

export const settings = $state<Settings>(load());

/** Persist the current settings. Call after any toggle. */
export function saveSettings(): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(settings));
}
