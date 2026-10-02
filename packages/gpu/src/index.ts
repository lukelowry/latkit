/** One Gpu per page, the View every renderer shares, compositions, and colormaps. */
export { createGpu } from './gpu.js';
export type { Gpu, GpuOptions } from './gpu.js';
export type { Budget, GpuStats } from './memory/memory.js';
export { GpuError } from './error.js';
export type { GpuErrorCode } from './error.js';
export type { View, ImageOptions } from './view/view.js';
export { createComposition } from './view/composition.js';
export type { CompositionConfig } from './view/composition.js';
export type { TextOptions, TextRasterizer, TextBitmap } from './text/text.js';
export { createTextRasterizer } from './text/rasterizer.js';
export { colormaps } from './colors/catalog.js';
export type { ColormapName } from './colors/catalog.js';
export { createColormap, reverseColormap } from './colors/colormap.js';
export type { Colormap, ColormapKind, ColormapOptions, ColorStop } from './colors/colormap.js';
export { parseColor, colorCss, colormapCss } from './colors/css.js';
export type { RGBA } from './colors/color.js';
export { spotlight } from './style/shade.js';
export type { Shade, ShadeFrame } from './style/shade.js';
/** Renderer authoring: the view base, frames, field uploads, shaders, text, and input. */
export * as kit from './kit.js';
