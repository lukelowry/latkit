/** One Gpu per page, the View every renderer shares, compositions, and colormaps. */
export { createGpu } from './gpu.js';
export type { Gpu, GpuOptions } from './gpu.js';
export { GpuError } from './error.js';
export type { GpuErrorCode } from './error.js';
export type { View } from './view.js';
export { createComposition } from './composition.js';
export { colormaps } from './colors/catalog.js';
export type { ColormapName } from './colors/catalog.js';
export { createColormap, reverseColormap } from './colors/colormap.js';
export type { Colormap } from './colors/colormap.js';
export { parseColor, colorCss, colormapCss } from './colors/css.js';
export type { RGBA } from './colors/color.js';
export { spotlight } from './shade.js';
export type { Shade } from './shade.js';
/** Renderer authoring: the view base, frames, native fields, shaders, and input. */
export * as kit from './kit.js';
