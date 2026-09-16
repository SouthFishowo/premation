/**
 * Isolated worker-spawn seam for the effect bake pool. `import.meta.url` lives
 * here alone so bakeWorkerPool.ts (and every Jest suite that reaches it through
 * AppTextureProvider) never has to parse it — this module is only reached via
 * a dynamic import at runtime, which Vite bundles and Jest never loads.
 */

export function spawnBakeWorker(): Worker {
  return new Worker(new URL('./bakeWorker.ts', import.meta.url), { type: 'module' });
}
