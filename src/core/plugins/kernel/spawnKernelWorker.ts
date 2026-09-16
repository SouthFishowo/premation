/**
 * Isolated worker-spawn seam for the plugin kernel pool.
 *
 * `import.meta.url` lives here alone so `kernelPool.ts` — and every Jest suite
 * that reaches it — never has to parse it. This module is only reached through
 * a dynamic import at runtime, which Vite bundles and Jest never loads. The
 * same arrangement as `spawnBakeWorker`, for the same reason.
 */

export function spawnKernelWorker(): Worker {
  return new Worker(new URL('./kernel.worker.ts', import.meta.url), { type: 'module' });
}
