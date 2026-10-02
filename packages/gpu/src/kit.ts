/** What renderer packages build on: the view base, frames, native fields, shaders, and input. */
export { BaseView, rendererOf, gpuOf, hold } from './view.js';
export type {
  ViewConfig,
  ViewEvents,
  ImageOptions,
  SetOptions,
  Patch,
  OptionsPatch,
  ConfigShape,
} from './view.js';
export type { CompositionConfig } from './composition.js';
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
export { validateRgba } from './colors/color.js';
export type { ColormapKind, ColormapOptions, ColorStop } from './colors/colormap.js';
export { sampleColormap } from './colors/sampling.js';
export { resolveColor } from './colors/css.js';
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
export type { ShadeFrame, ShadeRequest } from './shade.js';
export { shadeShader, defaultShade } from './shade.js';
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
export { createNativeReader } from './reader.js';
export type { NativeReader } from './reader.js';
