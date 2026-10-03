/** One Gpu per page, the views every renderer shares, compositions, and colormaps. */
export { createGpu } from './gpu.js';
export type { Gpu, GpuOptions } from './gpu.js';
export type {
  View,
  ViewConfig,
  ViewEvents,
  Patch,
  OptionsPatch,
  ImageOptions,
  SetOptions,
  ViewStats,
  Point,
} from './view/view.js';
export type { FrameInfo, Viewport } from './frame/render.js';
export type {
  ItemView,
  ItemViewConfig,
  ItemEvents,
  ViewCamera,
  ViewInput,
  PickOptions,
} from './view/item-view.js';
export { viewStyle } from './view/style.js';
export type { ViewStyle } from './view/style.js';
export type { Insets } from './view/camera.js';
export type { ContextMenu, Modifiers, HoverState } from './view/input.js';
export { createComposition } from './view/composition.js';
export type { Composition, CompositionConfig } from './view/composition.js';
export type { Scale, ColorScale, Position2D, Labels, Range, ScaleDomain } from './style/scale.js';
export type {
  TextOptions,
  TextRasterizer,
  TextBitmap,
  TextFont,
  TextInput,
  TextMetrics,
} from './text/text.js';
export { createTextRasterizer } from './text/rasterizer.js';
export { colormaps } from './colors/catalog.js';
export type { ColormapName } from './colors/catalog.js';
export { createColormap, reverseColormap } from './colors/colormap.js';
export type { Colormap, ColormapKind, ColormapOptions, ColorStop } from './colors/colormap.js';
export { parseColor, resolveColor, colorCss, colormapCss } from './colors/css.js';
export type { RGBA } from './colors/color.js';
export { spotlight } from './style/shade.js';
export type { Shade, ShadeFrame } from './style/shade.js';
/** Renderer authoring: the view base, frames, field uploads, shaders, text, and input. */
export * as kit from './kit.js';
