/**
 * The single place where the processing worker is created. Webpack 5 recognises this exact
 * `new Worker(new URL(...))` form and bundles the worker as its own file.
 */
export function spawnWorker(): Worker {
  return new Worker(new URL('./worker.ts', import.meta.url));
}
