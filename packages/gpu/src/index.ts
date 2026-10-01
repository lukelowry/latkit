/** Native column preparation, bounded GPU resources, and coordinated rendering. */
export { createGpu } from './gpu.js';
export type { Gpu, GpuOptions } from './gpu.js';
export { GpuError } from './error.js';
export type { GpuErrorCode } from './error.js';
export type { Budget, GpuStats } from './memory.js';
export type {
  Renderer,
  Invalidation,
  Preparation,
  Encoding,
  FrameInfo,
  Viewport,
  RenderTarget,
  RenderView,
  RenderOptions,
  QueryResult,
} from './render.js';
export type {
  FieldBinding,
  FieldInput,
  ExtentRequest,
  FieldsRequest,
  FieldValues,
  NativeFields,
  DataHit,
} from './binding.js';
export type {
  GpuField,
  GpuValueField,
  GpuListField,
  GpuEnvelopeField,
  GpuPage,
  UploadOptions,
} from './columns.js';
export { fieldShader } from './field-shader.js';
export { TextureData } from './texture-data.js';
export type { PixelRegion } from './texture-data.js';
export { BufferData } from './buffers.js';
export type { ByteRange } from './buffers.js';
export type { BufferResource } from './owned-buffer.js';
export type { TextureResource } from './resources.js';
export { createRenderTarget } from './target.js';
export type { TextureTarget, TargetSize } from './target.js';
export { createPresentation } from './presentation.js';
export type { Canvas, Presentation } from './presentation.js';
export { createCanvasView } from './canvas.js';
export type { CanvasView } from './canvas.js';

export type {
  TextInput,
  TextOptions,
  TextFont,
  TextMetrics,
  TextRun,
  TextRequest,
  TextPage,
  TextRasterizer,
  TextBitmap,
} from './text.js';
export { createTextRasterizer } from './text-rasterizer.js';
export { textShader } from './text-shader.js';

export { fitCamera, cameraPoint, worldPoint, zoomCamera } from './camera.js';
export type { Camera2D, Bounds2D, Insets } from './camera.js';

export { clipStroke, strokeShader } from './stroke.js';
export type { ClipPoint } from './stroke.js';

export type { RGBA } from './colors/color.js';
export { validateRgba } from './colors/color.js';
export type { Colormap, ColormapKind, ColormapOptions, ColorStop } from './colors/colormap.js';
export { createColormap, reverseColormap } from './colors/colormap.js';
export { sampleColormap } from './colors/sampling.js';
export { parseColor, resolveColor, colorCss, colormapCss } from './colors/css.js';
export { colormaps } from './colors/catalog.js';
export type { ColormapName } from './colors/catalog.js';
export { colormapShader } from './colors/shader.js';

export type {
  Range,
  ScaleDomain,
  Scale,
  ColorScale,
  Position2D,
  ScaleRequest,
  ResolvedScale,
} from './scale.js';
export { resolveScale, scaleValue, scaleParameters, scaleShader } from './scale.js';

export type { EnvelopeRequest } from './envelope.js';

export type { Shade, ShadeFrame, ShadeRequest } from './shade.js';
export { shadeShader, defaultShade, spotlight } from './shade.js';
export { premultipliedBlend, outputShader } from './output.js';

export type {
  Modifiers,
  ContextMenu,
  HoverOptions,
  HoverState,
  CanvasInput,
  BudgetResult,
} from './input.js';
export {
  inputModifiers,
  localPoint,
  wheelDelta,
  createCanvasInput,
  withinBudget,
} from './input.js';
