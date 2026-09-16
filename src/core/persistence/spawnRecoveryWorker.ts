/**
 * Isolated worker-spawn seam (same arrangement as `spawnEncodeWorker`).
 * `import.meta.url` lives here alone so `recovery.ts` and its Jest suites never
 * parse it — this module is only reached through a dynamic import at runtime.
 */

export function spawnRecoveryWorker(): Worker {
  return new Worker(new URL('./recovery.worker.ts', import.meta.url), { type: 'module' });
}
