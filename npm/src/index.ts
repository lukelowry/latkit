/// <reference lib="dom" preserve="true" />
/// <reference lib="esnext.disposable" preserve="true" />
/**
 * latkit: columnar data drawn with WebGPU.
 *
 * Scenes, expressions, patches, and the colormap catalog are plain data and need no WebAssembly.
 * Datasets, views, pictures, and `colormapCss` do, so call `await load()` first. Every `Handle`
 * works with `using`. The references above let the browser types latkit uses (canvases, `Blob`,
 * `Response`, `WebAssembly.Module`) and `Symbol.dispose` typecheck under any `lib` setting, in
 * Node.js too.
 */
export type * from './inputs.js';
export type * from './outputs.js';
export { load } from './load.js';
export {
  Handle,
  type ByteSource,
  type LatkitError,
  type ReadableBytes,
  type Wait,
} from './internal.js';
export {
  Data,
  Dataset,
  Snapshot,
  Table,
  Tiles,
  type Envelope,
  type QueryResult,
  type Source,
  type TableInput,
  type TilesOptions,
} from './data.js';
export {
  Patch,
  reference,
  type Fields,
  type Geometry,
  type Reference,
  type RowIds,
  type Run,
  type Values,
} from './patch.js';
export * from './scene.js';
export { colormapCss, colormaps } from './colormap.js';
export { Gpu } from './gpu.js';
export { View, type Insets, type Point, type Position, type ViewEvents } from './view.js';
export type { Placed, Rect } from './canvas.js';
export { Image, Shot, Video, type ImageFormat, type ShotOptions } from './shot.js';
