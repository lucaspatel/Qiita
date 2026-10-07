// Lazy, worker-based metameq validator — the Svelte port of kl-logger's
// usePyodide hook. The heavy engine (Pyodide + Python metameq/cerberus) runs in
// a Web Worker (static/pyodide-worker.js) off the main thread, and is only
// initialized on the FIRST validate() call, so a normal upload never pays for it.
import {
  PYODIDE_CDN_URL,
  BUILTIN_PACKAGES,
  MICROPIP_PACKAGES,
  CONFIG_PRESETS
} from './config';
import type { MetameqValidationResult, PyodideLoadState } from './types';

type Pending = {
  resolve: (r: MetameqValidationResult) => void;
  reject: (e: Error) => void;
};

class MetameqValidator {
  loadState = $state<PyodideLoadState>('idle');
  loadProgress = $state(0);
  error = $state<string | null>(null);

  #worker: Worker | null = null;
  #pending = new Map<string, Pending>();
  #readyWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  #configCache: string | null = null;

  get isReady() {
    return this.loadState === 'ready';
  }

  #ensureWorker() {
    if (this.#worker) return;
    const w = new Worker('/pyodide-worker.js');
    w.onmessage = (e) => this.#onMessage(e);
    w.onerror = (err) => this.#fail(`Worker error: ${err.message}`);
    this.#worker = w;
    this.loadState = 'loading-core';
    this.loadProgress = 5;
    this.error = null;
    w.postMessage({
      type: 'init',
      cdnUrl: PYODIDE_CDN_URL,
      builtinPackages: BUILTIN_PACKAGES,
      micropipPackages: MICROPIP_PACKAGES
    });
  }

  #fail(message: string) {
    this.error = message;
    this.loadState = 'error';
    for (const w of this.#readyWaiters) w.reject(new Error(message));
    this.#readyWaiters = [];
  }

  #onMessage(event: MessageEvent) {
    const { type, id, ...data } = event.data;
    if (type === 'progress') {
      this.loadState = data.state;
      this.loadProgress = data.progress;
    } else if (type === 'initialized') {
      if (data.success) {
        this.loadState = 'ready';
        this.loadProgress = 100;
        for (const w of this.#readyWaiters) w.resolve();
        this.#readyWaiters = [];
      }
    } else if (type === 'validation-result') {
      this.#pending.get(id)?.resolve(data.result);
      this.#pending.delete(id);
    } else if (type === 'error') {
      if (id) {
        this.#pending.get(id)?.reject(new Error(data.message));
        this.#pending.delete(id);
      } else {
        this.#fail(data.message);
      }
    }
  }

  #ready(): Promise<void> {
    if (this.loadState === 'ready') return Promise.resolve();
    this.#ensureWorker();
    return new Promise((resolve, reject) => this.#readyWaiters.push({ resolve, reject }));
  }

  async #config(): Promise<string> {
    if (this.#configCache) return this.#configCache;
    const r = await fetch(CONFIG_PRESETS.default);
    if (!r.ok) throw new Error(`metameq config failed to load (${r.status})`);
    this.#configCache = await r.text();
    return this.#configCache;
  }

  /** Validate a metadata file against the metameq standards. Lazily boots the
   *  worker + Pyodide on first call. Never throws for *validation* findings —
   *  those come back in the result; it throws only for infra failures. */
  async validate(file: File): Promise<MetameqValidationResult> {
    const configYaml = await this.#config();
    await this.#ready();
    const fileData = await file.arrayBuffer();
    const id = `v-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker!.postMessage({ type: 'validate', id, fileData, fileName: file.name, configYaml });
    });
  }
}

export const metameq = new MetameqValidator();
