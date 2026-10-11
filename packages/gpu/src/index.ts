/** One Gpu per page, the views every renderer shares, compositions, and colormaps. */
export { createGpu } from './gpu.js';
export type { Gpu } from './gpu.js';
export type { View, Point } from './view/view.js';
export type { FrameInfo, Viewport } from './frame/render.js';
export type { ItemView } from './view/item-view.js';
export type { ProjectedCamera } from './view/projection.js';
export type { Insets } from './view/camera.js';
export { createComposition } from './view/composition.js';
export type { Composition } from './view/composition.js';
export type { Scale, Labels } from './style/scale.js';
export type { Channel } from './style/channel.js';
export { shape, gauge, pie, icon } from './style/marker.js';
export type { Marker, Shape } from './style/marker.js';
export type { Layout } from './layout/place.js';
export type { TextRasterizer } from './text/text.js';
export { createTextRasterizer } from './text/rasterizer.js';
export { colormaps } from './colors/catalog.js';
export { createColormap, reverseColormap } from './colors/colormap.js';
export type { Colormap } from './colors/colormap.js';
export { parseColor, resolveColor, colorCss, colormapCss } from './colors/css.js';
export type { RGBA } from './colors/color.js';
export { spotlight, pulse } from './style/shade.js';
export type { Shade } from './style/shade.js';
/** Renderer authoring: the view base, frames, field uploads, shaders, text, and input. */
export * as kit from './kit.js';
