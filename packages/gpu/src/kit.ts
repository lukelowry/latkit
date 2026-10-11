/** What renderer packages build on: the view base, frames, field uploads, shaders, text, and input. */
export { BaseView, rendererOf, gpuOf, hold, layerOf } from './view/view.js';
export type { Layer, LayerLook, LayerScene, CapturedLayer, PreparedLayer } from './view/layer.js';
export { Projector, PROJECTIONS, projectionShader } from './view/projection.js';
export type { Light, Projected } from './view/projection.js';
export type { ConfigShape } from './view/view.js';
export { BaseItemView, resolveLimits } from './view/item-view.js';
export type { Framing, HoverSearch, ItemShape } from './view/item-view.js';
export { ProjectedView } from './view/projected-view.js';
export {
  resolveStyle,
  resolveViewStyle,
  viewStyle,
  lineStyle,
  projectedStyle,
} from './view/style.js';
export type {
  ResolvedViewStyle,
  LineStyle,
  ProjectedStyle,
  StyleRule,
  StyleRules,
} from './view/style.js';
export { Attachments } from './view/attachments.js';
export type {
  Renderer,
  CapturedFrame,
  PreparedFrame,
  Preparation,
  Encoding,
  RenderTarget,
  RenderView,
  RenderOptions,
} from './frame/render.js';
export type {
  GpuField,
  GpuValueField,
  GpuListField,
  GpuEnvelopeField,
  GpuPage,
  UploadOptions,
} from './fields/types.js';
export { fieldShader } from './fields/shader.js';
export { TextureData } from './memory/texture-data.js';
export type { PixelRegion } from './memory/texture-data.js';
export { BufferData } from './memory/buffer-data.js';
export type { ByteRange } from './memory/buffer-data.js';
export type { BufferResource } from './memory/buffers.js';
export { Feedback } from './memory/feedback.js';
export type { TextureResource } from './memory/textures.js';
export { createTextureTarget } from './view/target.js';
export type { TextureTarget, TargetSize } from './view/target.js';
export { createPresentation } from './view/presentation.js';
export type { Canvas, Presentation } from './view/presentation.js';
export type {
  TextRun,
  TextRequest,
  TextPage,
  TextLayout,
  TextLayoutInput,
  TextAlign,
  TextBaseline,
} from './text/text.js';
export { textShader } from './text/shader.js';
export { TextBank, textOrigin, textBox } from './text/bank.js';
export type { TextBankPage, TextCandidate, TextPlacement } from './text/bank.js';
export { fitCamera, cameraPoint, worldPoint, zoomCamera } from './view/camera.js';
export type { Camera2D, Bounds2D } from './view/camera.js';
export { BoxIndex, Occupancy } from './spatial/boxes.js';
export type { BoxRead } from './spatial/boxes.js';
export { wiring, readRows } from './view/wiring.js';
export { Graph } from './layout/graph.js';
export type { Runs, Parts } from './layout/graph.js';
export { place, layoutOptions } from './layout/place.js';
export { sameReads, sameRecords, sameValues } from './view/changes.js';
export type { Wiring, End, Port } from './view/wiring.js';
export { clipStroke, strokeShader } from './style/stroke.js';
export type { ClipPoint } from './style/stroke.js';
export { clearColor, validateRgba } from './colors/color.js';
export { sampleColormap } from './colors/sampling.js';
export { colormapShader } from './colors/shader.js';
export type { ScaleRequest, ResolvedScale } from './style/scale.js';
export { fieldScale, resolveScale, scaleValue, resolveLabels } from './style/scale.js';
export type {
  ChannelKind,
  ChannelScale,
  BoundChannel,
  BoundChannels,
  ResolvedChannel,
} from './style/channel.js';
export {
  bindChannels,
  resolveChannels,
  resolveChannel,
  channelValue,
  channelValues,
  channelOn,
  writeChannel,
} from './style/channel.js';
export {
  checkMarker,
  markerShader,
  shapeShader,
  markerAtlas,
  SHAPES,
  MARKER_INPUTS,
} from './style/marker.js';
export { shadeShader } from './style/shade.js';
export { premultipliedBlend, outputShader } from './style/output.js';
export type { CanvasInput } from './view/input.js';
export type { Grab } from './view/item-view.js';
export { inputModifiers } from './view/input.js';
