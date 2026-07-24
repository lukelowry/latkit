/** Projection and camera uniforms shared by all projection shaders. */
export interface ProjectionRegion {
  /** Writes the 4x4 view-projection matrix into words 0..15. */
  setVP(m: Float32Array): void;
  /** Writes the camera position in projection/world space. */
  setCameraPos(x: number, y: number, z: number): void;
  /** Perspective field-of-view scale used by billboard sizing. */
  fovScale: number;
  /** Writes the normalized light direction for daylight shading. */
  setLightDir(x: number, y: number, z: number): void;
  /** Writes tilt look-at point and bearing basis into words 92..95. */
  setTiltParams(lookX: number, lookY: number, sinB: number, cosB: number): void;
  /** Minimum overlay brightness on the night side. */
  nightFloor: number;
  /** Width of the daylight terminator blend band. */
  terminatorWidth: number;
  /** Minimum opaque-surface brightness on the night side. */
  surfaceNightFloor: number;
  /** Projection flags bitmask shared with uniforms.wgsl. */
  flags: number;
  /** Flat projection x scale. */
  flatSx: number;
  /** Flat projection y scale. */
  flatSy: number;
  /** Flat projection x translation. */
  flatTx: number;
  /** Flat projection y translation. */
  flatTy: number;
}

/** Per-frame uniforms that change with canvas size or time. */
interface FrameRegion {
  /** Viewport width in device pixels. */
  viewportX: number;
  /** Viewport height in device pixels. */
  viewportY: number;
  /** Monotonic frame time used by time-varying shaders. */
  time: number;
  /** Backing pixels per CSS pixel after device-limit fitting. */
  backingScale: number;
}

/** Geometry-scale uniforms derived from topology and channel state. */
interface GeometryRegion {
  /** Base vertex radius in graph/world units. */
  vertexSize: number;
  /** Screen-space level-of-detail threshold for vertex rendering. */
  vertexLod: number;
  /** Base edge half-width in graph/world units. */
  baseEdgeWidth: number;
  /** Dash period in CSS pixels; zero disables edge dashing. */
  dashPeriod: number;
  /** Projection-space visual amplitude of normalized height. */
  heightWorldScale: number;
}

/** Focus-state uniforms for hover and selection rendering. */
interface FocusRegion {
  /** Hovered vertex id, or -1 when none. */
  hoverVertex: number;
  /** Hovered edge id, or -1 when none. */
  hoverEdge: number;
  /** Selected vertex id, or -1 when none. */
  selectedVertex: number;
  /** Selected edge id, or -1 when none. */
  selectedEdge: number;
  /** Packed hover color consumed by focus shaders. */
  hoverColor: number;
  /** Packed selected color consumed by focus shaders. */
  selectedColor: number;
  /** Focus flags bitmask shared with uniforms.wgsl. */
  flags: number;
  /** Hover overlay opacity. */
  hoverAlpha: number;
  /** Selection overlay opacity. */
  selectedAlpha: number;
  /** Extra vertex halo radius for hover focus. */
  vertexHoverUnderlayPx: number;
  /** Extra vertex halo radius for selection focus. */
  vertexSelectedUnderlayPx: number;
  /** Extra edge halo half-width for hover focus. */
  edgeHoverUnderlayPx: number;
  /** Extra edge halo half-width for selection focus. */
  edgeSelectedUnderlayPx: number;
  /** Writes endpoint ids used by optional focused-edge endpoint highlighting. */
  setEndpointIds(hoverA: number, hoverB: number, selectedA: number, selectedB: number): void;
}

/** Channel storage offsets, modes, and normalization scalars. */
interface ChannelRegion {
  /** Float-word offset for vertexColor channel storage. */
  vColorOffset: number;
  /** Float-word offset for edgeColor channel storage. */
  eColorOffset: number;
  /** Float-word offset for edgeDash channel storage. */
  eDashOffset: number;
  /** Float-word offset for vertexHeight channel storage. */
  vHeightOffset: number;
  /** Vertex color shader mode. */
  vColorMode: number;
  /** Vertex color input-domain minimum. */
  vColorMin: number;
  /** Vertex color input-domain reciprocal scale. */
  vColorScale: number;
  /** Edge color shader mode. */
  eColorMode: number;
  /** Edge color input-domain minimum. */
  eColorMin: number;
  /** Edge color input-domain reciprocal scale. */
  eColorScale: number;
  /** Vertex height input-domain center/minimum used by shader normalization. */
  heightCenter: number;
  /** Vertex height input-domain reciprocal scale. */
  heightScale: number;
  /** Vertex height output-range minimum. */
  heightOutMin: number;
  /** Vertex height output-range scale. */
  heightOutScale: number;
  /** Vertex height shader mode. */
  vHeightMode: number;
  /** Float-word offset for vertexSize channel storage. */
  vSizeOffset: number;
  /** Vertex size shader mode. */
  vSizeMode: number;
  /** Vertex size input-domain minimum. */
  vSizeMin: number;
  /** Vertex size input-domain reciprocal scale. */
  vSizeScale: number;
}

/** CPU-side view of the packed uniform buffer shared with WGSL. */
export interface Uniforms {
  /** Backing buffer uploaded wholesale to the GPU each frame. */
  readonly raw: ArrayBuffer;
  /** Cached signed 32-bit view over {@link Uniforms.raw}. */
  readonly rawI32: Int32Array;
  /** Cached unsigned 32-bit view over {@link Uniforms.raw}. */
  readonly rawU32: Uint32Array;
  /** Projection and camera uniform accessors. */
  readonly projection: ProjectionRegion;
  /** Per-frame uniform accessors. */
  readonly frame: FrameRegion;
  /** Topology and geometry uniform accessors. */
  readonly geometry: GeometryRegion;
  /** Focus-state uniform accessors. */
  readonly focus: FocusRegion;
  /** Channel layout and normalization uniform accessors. */
  readonly channel: ChannelRegion;
  /** Resting vertex color when the vertexColor channel carries no signal. */
  readonly baseVertexColor: Float32Array;
  /** Shared graticule line color at bytes 304..319, RGBA in 0..1. */
  readonly gridColor: Float32Array;
  /** Tilt ground plane and globe sphere base tone at bytes 320..335. */
  readonly surfaceColor: Float32Array;
  /** Geographic border tint at bytes 336..351; shaders keep per-tier alpha. */
  readonly borderColor: Float32Array;
}

/** Total byte length of the packed uniform buffer shared with WGSL. */
export const UNIFORM_BUFFER_BYTES = 384;

/** Projection flag bit for daylight shading; must match uniforms.wgsl. */
export const FLAG_DAYLIGHT = 1;
/** Projection flag bit for graticule rendering; must match uniforms.wgsl. */
export const FLAG_GRATICULE = 2;
/** Focus flag bit that enables hover/selection rendering. */
export const FLAG_FOCUS_ENABLED = 1;
/** Focus flag bit that includes selected edge endpoints. */
export const FLAG_FOCUS_SELECTED_ENDPOINTS = 2;
/** Focus flag bit that includes hovered edge endpoints. */
export const FLAG_FOCUS_HOVER_ENDPOINTS = 4;

/** Word offset for the start of the 4x4 view-projection matrix. */
const W_VP_0 = 0;
/** Word offset for camera x position. */
export const W_CAMERA_X = 16;
/** Word offset for camera y position. */
export const W_CAMERA_Y = 17;
/** Word offset for camera z position. */
export const W_CAMERA_Z = 18;
/** Word offset for camera field-of-view scale. */
export const W_FOV_SCALE = 19;
/** Word offset for light direction x. */
const W_LIGHT_X = 20;
/** Word offset for light direction y. */
const W_LIGHT_Y = 21;
/** Word offset for light direction z. */
const W_LIGHT_Z = 22;
/** Word offset for projection flags. */
const W_PROJECTION_FLAGS = 23;
/** Word offset for flat projection x scale. */
export const W_FLAT_SX = 24;
/** Word offset for flat projection y scale. */
export const W_FLAT_SY = 25;
/** Word offset for flat projection x translation. */
export const W_FLAT_TX = 26;
/** Word offset for flat projection y translation. */
export const W_FLAT_TY = 27;
/** Word offset for viewport width. */
export const W_VIEWPORT_X = 28;
/** Word offset for viewport height. */
export const W_VIEWPORT_Y = 29;
/** Word offset for frame time. */
const W_TIME = 30;
/** Word offset for backing pixels per CSS pixel. */
const W_BACKING_SCALE = 88;
/** Word offset for base vertex radius. */
export const W_VERTEX_SIZE = 31;
/** Word offset for vertex level-of-detail threshold. */
export const W_VERTEX_LOD = 32;
/** Word offset for base edge half-width. */
export const W_BASE_EDGE_WIDTH = 33;
/** Word offset for edge dash period. */
export const W_DASH_PERIOD = 34;
/** Word offset for height amplitude in world units. */
export const W_HEIGHT_WORLD_SCALE = 35;
/** Word offset for hovered vertex id. */
export const W_HOVER_VERTEX = 36;
/** Word offset for hovered edge id. */
export const W_HOVER_EDGE = 37;
/** Word offset for selected vertex id. */
export const W_SELECTED_VERTEX = 38;
/** Word offset for selected edge id. */
export const W_SELECTED_EDGE = 39;
/** Word offset for vertexColor storage offset. */
const W_V_COLOR_OFFSET = 40;
/** Word offset for edgeColor storage offset. */
const W_E_COLOR_OFFSET = 41;
/** Word offset for edgeDash storage offset. */
const W_E_DASH_OFFSET = 42;
/** Word offset for vertexHeight storage offset. */
const W_V_HEIGHT_OFFSET = 43;
/** Word offset for vertexColor shader mode. */
const W_V_COLOR_MODE = 44;
/** Word offset for vertexColor domain minimum. */
const W_V_COLOR_MIN = 45;
/** Word offset for vertexColor normalization scale. */
const W_V_COLOR_SCALE = 46;
/** Word offset for edgeColor shader mode. */
const W_E_COLOR_MODE = 47;
/** Word offset for edgeColor domain minimum. */
const W_E_COLOR_MIN = 48;
/** Word offset for edgeColor normalization scale. */
const W_E_COLOR_SCALE = 49;
/** Word offset for vertexHeight domain center/minimum. */
export const W_HEIGHT_CENTER = 50;
/** Word offset for vertexHeight normalization scale. */
export const W_HEIGHT_SCALE = 51;
/** Word offset for vertexHeight shader mode. */
export const W_V_HEIGHT_MODE = 52;
/** Word offset for vertexSize storage offset. */
const W_V_SIZE_OFFSET = 53;
/** Word offset for vertexSize shader mode. */
export const W_V_SIZE_MODE = 54;
/** Word offset for vertexSize domain minimum. */
export const W_V_SIZE_MIN = 55;
/** Word offset for vertexSize normalization scale. */
export const W_V_SIZE_SCALE = 56;
/** Word offset for packed hover focus color. */
const W_FOCUS_HOVER_COLOR = 57;
/** Word offset for packed selected focus color. */
const W_FOCUS_SELECTED_COLOR = 58;
/** Word offset for focus flags. */
export const W_FOCUS_FLAGS = 59;
/** Word offset for hover focus alpha. */
const W_FOCUS_HOVER_ALPHA = 60;
/** Word offset for selected focus alpha. */
const W_FOCUS_SELECTED_ALPHA = 61;
/** Word offset for vertex hover underlay radius. */
const W_FOCUS_VERTEX_HOVER_UNDERLAY_PX = 62;
/** Word offset for vertex selected underlay radius. */
const W_FOCUS_VERTEX_SELECTED_UNDERLAY_PX = 63;
/** Word offset for edge hover underlay width. */
const W_FOCUS_EDGE_HOVER_UNDERLAY_PX = 64;
/** Word offset for edge selected underlay width. */
const W_FOCUS_EDGE_SELECTED_UNDERLAY_PX = 65;
/** Word offset for vertexHeight output range minimum. */
export const W_HEIGHT_OUT_MIN = 66;
/** Word offset for vertexHeight output range scale. */
export const W_HEIGHT_OUT_SCALE = 67;
/** Word offset for hovered edge endpoint A. */
export const W_HOVER_ENDPOINT_A = 68;
/** Word offset for hovered edge endpoint B. */
export const W_HOVER_ENDPOINT_B = 69;
/** Word offset for selected edge endpoint A. */
export const W_SELECTED_ENDPOINT_A = 70;
/** Word offset for selected edge endpoint B. */
export const W_SELECTED_ENDPOINT_B = 71;
/** Word offset for the first component of base vertex color. */
const W_BASE_VERTEX_COLOR_R = 72;
/** Word offset for overlay night-side floor. */
const W_NIGHT_FLOOR = 89;
/** Word offset for daylight terminator width. */
const W_TERMINATOR_WIDTH = 90;
/** Word offset for surface night-side floor. */
const W_SURFACE_NIGHT_FLOOR = 91;
/** Word offset for tilt look-at x. */
const W_TILT_LOOK_X = 92;
/** Word offset for tilt look-at y. */
const W_TILT_LOOK_Y = 93;
/** Word offset for tilt bearing sine. */
const W_TILT_SIN_BEARING = 94;
/** Word offset for tilt bearing cosine. */
const W_TILT_COS_BEARING = 95;

/** Tests whether the graticule projection flag is enabled in a raw uniform view. */
export function hasGraticuleFlag(u: Uint32Array): boolean {
  return (u[W_PROJECTION_FLAGS]! & FLAG_GRATICULE) !== 0;
}

/** Tests whether the vertexHeight channel mode is active in a raw uniform view. */
export function hasVertexHeightChannel(u: Uint32Array): boolean {
  return u[W_V_HEIGHT_MODE] !== 0;
}

/** Allocates a zeroed uniform buffer and typed region accessors over it. */
export function createUniforms(): Uniforms {
  const buf = new ArrayBuffer(UNIFORM_BUFFER_BYTES);
  const f = new Float32Array(buf);
  const i = new Int32Array(buf);
  const u = new Uint32Array(buf);
  f[W_BACKING_SCALE] = 1;

  const projection: ProjectionRegion = {
    setVP(m: Float32Array) {
      f.set(m.subarray(0, 16), W_VP_0);
    },
    setCameraPos(x, y, z) {
      f[W_CAMERA_X] = x;
      f[W_CAMERA_Y] = y;
      f[W_CAMERA_Z] = z;
    },
    get fovScale() {
      return f[W_FOV_SCALE];
    },
    set fovScale(v) {
      f[W_FOV_SCALE] = v;
    },
    setLightDir(x, y, z) {
      f[W_LIGHT_X] = x;
      f[W_LIGHT_Y] = y;
      f[W_LIGHT_Z] = z;
    },
    setTiltParams(lookX, lookY, sinB, cosB) {
      f[W_TILT_LOOK_X] = lookX;
      f[W_TILT_LOOK_Y] = lookY;
      f[W_TILT_SIN_BEARING] = sinB;
      f[W_TILT_COS_BEARING] = cosB;
    },
    get nightFloor() {
      return f[W_NIGHT_FLOOR];
    },
    set nightFloor(v) {
      f[W_NIGHT_FLOOR] = v;
    },
    get terminatorWidth() {
      return f[W_TERMINATOR_WIDTH];
    },
    set terminatorWidth(v) {
      f[W_TERMINATOR_WIDTH] = v;
    },
    get surfaceNightFloor() {
      return f[W_SURFACE_NIGHT_FLOOR];
    },
    set surfaceNightFloor(v) {
      f[W_SURFACE_NIGHT_FLOOR] = v;
    },
    get flags() {
      return u[W_PROJECTION_FLAGS];
    },
    set flags(v) {
      u[W_PROJECTION_FLAGS] = v;
    },
    get flatSx() {
      return f[W_FLAT_SX];
    },
    set flatSx(v) {
      f[W_FLAT_SX] = v;
    },
    get flatSy() {
      return f[W_FLAT_SY];
    },
    set flatSy(v) {
      f[W_FLAT_SY] = v;
    },
    get flatTx() {
      return f[W_FLAT_TX];
    },
    set flatTx(v) {
      f[W_FLAT_TX] = v;
    },
    get flatTy() {
      return f[W_FLAT_TY];
    },
    set flatTy(v) {
      f[W_FLAT_TY] = v;
    },
  };

  const frame: FrameRegion = {
    get viewportX() {
      return f[W_VIEWPORT_X];
    },
    set viewportX(v) {
      f[W_VIEWPORT_X] = v;
    },
    get viewportY() {
      return f[W_VIEWPORT_Y];
    },
    set viewportY(v) {
      f[W_VIEWPORT_Y] = v;
    },
    get time() {
      return f[W_TIME];
    },
    set time(v) {
      f[W_TIME] = v;
    },
    get backingScale() {
      return f[W_BACKING_SCALE];
    },
    set backingScale(v) {
      f[W_BACKING_SCALE] = v;
    },
  };

  const geometry: GeometryRegion = {
    get vertexSize() {
      return f[W_VERTEX_SIZE];
    },
    set vertexSize(v) {
      f[W_VERTEX_SIZE] = v;
    },
    get vertexLod() {
      return f[W_VERTEX_LOD];
    },
    set vertexLod(v) {
      f[W_VERTEX_LOD] = v;
    },
    get baseEdgeWidth() {
      return f[W_BASE_EDGE_WIDTH];
    },
    set baseEdgeWidth(v) {
      f[W_BASE_EDGE_WIDTH] = v;
    },
    get dashPeriod() {
      return f[W_DASH_PERIOD];
    },
    set dashPeriod(v) {
      f[W_DASH_PERIOD] = v;
    },
    get heightWorldScale() {
      return f[W_HEIGHT_WORLD_SCALE];
    },
    set heightWorldScale(v) {
      f[W_HEIGHT_WORLD_SCALE] = v;
    },
  };

  const focus: FocusRegion = {
    get hoverVertex() {
      return i[W_HOVER_VERTEX];
    },
    set hoverVertex(v) {
      i[W_HOVER_VERTEX] = v;
    },
    get hoverEdge() {
      return i[W_HOVER_EDGE];
    },
    set hoverEdge(v) {
      i[W_HOVER_EDGE] = v;
    },
    get selectedVertex() {
      return i[W_SELECTED_VERTEX];
    },
    set selectedVertex(v) {
      i[W_SELECTED_VERTEX] = v;
    },
    get selectedEdge() {
      return i[W_SELECTED_EDGE];
    },
    set selectedEdge(v) {
      i[W_SELECTED_EDGE] = v;
    },
    get hoverColor() {
      return u[W_FOCUS_HOVER_COLOR];
    },
    set hoverColor(v) {
      u[W_FOCUS_HOVER_COLOR] = v;
    },
    get selectedColor() {
      return u[W_FOCUS_SELECTED_COLOR];
    },
    set selectedColor(v) {
      u[W_FOCUS_SELECTED_COLOR] = v;
    },
    get flags() {
      return u[W_FOCUS_FLAGS];
    },
    set flags(v) {
      u[W_FOCUS_FLAGS] = v;
    },
    get hoverAlpha() {
      return f[W_FOCUS_HOVER_ALPHA];
    },
    set hoverAlpha(v) {
      f[W_FOCUS_HOVER_ALPHA] = v;
    },
    get selectedAlpha() {
      return f[W_FOCUS_SELECTED_ALPHA];
    },
    set selectedAlpha(v) {
      f[W_FOCUS_SELECTED_ALPHA] = v;
    },
    get vertexHoverUnderlayPx() {
      return f[W_FOCUS_VERTEX_HOVER_UNDERLAY_PX];
    },
    set vertexHoverUnderlayPx(v) {
      f[W_FOCUS_VERTEX_HOVER_UNDERLAY_PX] = v;
    },
    get vertexSelectedUnderlayPx() {
      return f[W_FOCUS_VERTEX_SELECTED_UNDERLAY_PX];
    },
    set vertexSelectedUnderlayPx(v) {
      f[W_FOCUS_VERTEX_SELECTED_UNDERLAY_PX] = v;
    },
    get edgeHoverUnderlayPx() {
      return f[W_FOCUS_EDGE_HOVER_UNDERLAY_PX];
    },
    set edgeHoverUnderlayPx(v) {
      f[W_FOCUS_EDGE_HOVER_UNDERLAY_PX] = v;
    },
    get edgeSelectedUnderlayPx() {
      return f[W_FOCUS_EDGE_SELECTED_UNDERLAY_PX];
    },
    set edgeSelectedUnderlayPx(v) {
      f[W_FOCUS_EDGE_SELECTED_UNDERLAY_PX] = v;
    },
    setEndpointIds(hoverA, hoverB, selectedA, selectedB) {
      i[W_HOVER_ENDPOINT_A] = hoverA;
      i[W_HOVER_ENDPOINT_B] = hoverB;
      i[W_SELECTED_ENDPOINT_A] = selectedA;
      i[W_SELECTED_ENDPOINT_B] = selectedB;
    },
  };

  const channel: ChannelRegion = {
    get vColorOffset() {
      return u[W_V_COLOR_OFFSET];
    },
    set vColorOffset(v) {
      u[W_V_COLOR_OFFSET] = v;
    },
    get eColorOffset() {
      return u[W_E_COLOR_OFFSET];
    },
    set eColorOffset(v) {
      u[W_E_COLOR_OFFSET] = v;
    },
    get eDashOffset() {
      return u[W_E_DASH_OFFSET];
    },
    set eDashOffset(v) {
      u[W_E_DASH_OFFSET] = v;
    },
    get vHeightOffset() {
      return u[W_V_HEIGHT_OFFSET];
    },
    set vHeightOffset(v) {
      u[W_V_HEIGHT_OFFSET] = v;
    },
    get vColorMode() {
      return u[W_V_COLOR_MODE];
    },
    set vColorMode(v) {
      u[W_V_COLOR_MODE] = v;
    },
    get vColorMin() {
      return f[W_V_COLOR_MIN];
    },
    set vColorMin(v) {
      f[W_V_COLOR_MIN] = v;
    },
    get vColorScale() {
      return f[W_V_COLOR_SCALE];
    },
    set vColorScale(v) {
      f[W_V_COLOR_SCALE] = v;
    },
    get eColorMode() {
      return u[W_E_COLOR_MODE];
    },
    set eColorMode(v) {
      u[W_E_COLOR_MODE] = v;
    },
    get eColorMin() {
      return f[W_E_COLOR_MIN];
    },
    set eColorMin(v) {
      f[W_E_COLOR_MIN] = v;
    },
    get eColorScale() {
      return f[W_E_COLOR_SCALE];
    },
    set eColorScale(v) {
      f[W_E_COLOR_SCALE] = v;
    },
    get heightCenter() {
      return f[W_HEIGHT_CENTER];
    },
    set heightCenter(v) {
      f[W_HEIGHT_CENTER] = v;
    },
    get heightScale() {
      return f[W_HEIGHT_SCALE];
    },
    set heightScale(v) {
      f[W_HEIGHT_SCALE] = v;
    },
    get vHeightMode() {
      return u[W_V_HEIGHT_MODE];
    },
    set vHeightMode(v) {
      u[W_V_HEIGHT_MODE] = v;
    },
    get vSizeOffset() {
      return u[W_V_SIZE_OFFSET];
    },
    set vSizeOffset(v) {
      u[W_V_SIZE_OFFSET] = v;
    },
    get vSizeMode() {
      return u[W_V_SIZE_MODE];
    },
    set vSizeMode(v) {
      u[W_V_SIZE_MODE] = v;
    },
    get vSizeMin() {
      return f[W_V_SIZE_MIN];
    },
    set vSizeMin(v) {
      f[W_V_SIZE_MIN] = v;
    },
    get vSizeScale() {
      return f[W_V_SIZE_SCALE];
    },
    set vSizeScale(v) {
      f[W_V_SIZE_SCALE] = v;
    },
    get heightOutMin() {
      return f[W_HEIGHT_OUT_MIN];
    },
    set heightOutMin(v) {
      f[W_HEIGHT_OUT_MIN] = v;
    },
    get heightOutScale() {
      return f[W_HEIGHT_OUT_SCALE];
    },
    set heightOutScale(v) {
      f[W_HEIGHT_OUT_SCALE] = v;
    },
  };

  focus.hoverVertex = -1;
  focus.hoverEdge = -1;
  focus.selectedVertex = -1;
  focus.selectedEdge = -1;
  focus.setEndpointIds(-1, -1, -1, -1);

  const gridColor = new Float32Array(buf, 304, 4);
  const surfaceColor = new Float32Array(buf, 320, 4);
  const borderColor = new Float32Array(buf, 336, 4);

  return {
    raw: buf,
    rawI32: i,
    rawU32: u,
    projection,
    frame,
    geometry,
    focus,
    channel,
    baseVertexColor: new Float32Array(
      buf,
      W_BASE_VERTEX_COLOR_R * Float32Array.BYTES_PER_ELEMENT,
      4,
    ),
    gridColor,
    surfaceColor,
    borderColor,
  };
}
