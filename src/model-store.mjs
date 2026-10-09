import { readFileSync, watchFile, unwatchFile } from 'node:fs';
import { validateModels } from './config-store.mjs';

export function watchModels(path, initial, providers, onReload, onError) {
  let previous = JSON.stringify(initial);
  let lastError = '';
  function reload() {
    try {
      const candidate = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')).models;
      validateModels(candidate, providers);
      const serialized = JSON.stringify(candidate);
      if (serialized !== previous) {
        onReload(candidate);
        previous = serialized;
      }
      lastError = '';
    } catch (error) {
      if (error.message !== lastError) onError(error);
      lastError = error.message;
    }
  }
  // Poll the file path so atomic replacement during save is detected on Windows too.
  watchFile(path, { interval: 500, persistent: false }, reload);
  return () => unwatchFile(path, reload);
}
