/// <reference lib="esnext.disposable" preserve="true" />
/**
 * latkit: columnar data drawn with WebGPU. Scenes, expressions, and patches are plain data, usable
 * anywhere; `await load()` loads the WebAssembly that datasets, views, and pictures are made with.
 * Its handles dispose with `using`, whatever library a project compiles against.
 */
export type * from './inputs.js';
export type * from './outputs.js';
export { load, type LoadOptions } from './load.js';
export type { LatkitError, Wait } from './internal.js';
export {
  Data,
  Snapshot,
  Tiles,
  type DataSource,
  type Envelope,
  type QueryResult,
  type Source,
} from './data.js';
export {
  Patch,
  reference,
  type Fields,
  type Geometry,
  type PatchSource,
  type ReadableBytes,
  type Reference,
  type RowIds,
  type Values,
} from './patch.js';
export * from './scene.js';
export { colormapCss } from './colormap.js';
export { Gpu } from './gpu.js';
export {
  View,
  type Insets,
  type Point,
  type Position,
  type ViewEvents,
  type ViewOptions,
} from './view.js';
export { Canvas, type CanvasOptions, type Panel, type Rect } from './canvas.js';
export { Image, Shot, Video, type ImageFormat, type ShotOptions } from './shot.js';
