/**
 * Isolated worker-spawn seam for the decode worker. `import.meta.url` lives
 * here alone so the decode client (and its Jest suites) never has to parse it —
 * this module is only ever reached via a dynamic import at runtime, which Vite
 * bundles and Jest never loads. Same shape as `spawnDemuxWorker`.
 */

export function spawnDecodeWorker(): Worker {
  return new Worker(new URL('./decode.worker.ts', import.meta.url), { type: 'module' });
}
