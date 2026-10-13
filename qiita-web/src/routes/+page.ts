import { redirect } from '@sveltejs/kit';

// The app has no landing page of its own; references are the first nav item's home.
export function load() {
  redirect(307, '/references');
}
