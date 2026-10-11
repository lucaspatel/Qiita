// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
  namespace App {}
  // Injected by vite.config.ts; empty in a production build.
  const __QIITA_DEV_ENVS__: { name: string; origin: string }[];
  const __QIITA_DEV_DEFAULT_ENV__: string;
}

export {};
