/**
 * Worker-realm stand-ins for the one DOM call the effect kernels make.
 *
 * Several kernels keep a module-level scratch canvas and create it with
 * `document.createElement('canvas')` (the canvas2dEffects role pool, the
 * procedural noise tile, Vegas, the mask feather). A worker has no `document`,
 * and OffscreenCanvas answers every call those scratches receive, so the bake
 * worker installs a `document` whose only member makes one.
 *
 * Deliberately NOTHING else. Defining `window`, `document.fonts` or a body
 * would make guarded code elsewhere believe it is in a page and reach for
 * listeners and storage that do not exist; failing loudly on anything but a
 * canvas is the safer contract. Must be the worker entry's FIRST import — ES
 * modules evaluate in import order, and the kernels' modules may create their
 * scratches while loading.
 */

const g = globalThis as { document?: unknown };
if (typeof g.document === 'undefined' && typeof OffscreenCanvas !== 'undefined') {
  g.document = {
    createElement(tag: string): OffscreenCanvas {
      if (tag !== 'canvas') throw new Error(`bake worker: document.createElement('${tag}') is unavailable`);
      return new OffscreenCanvas(1, 1);
    },
  };
}

export {};
