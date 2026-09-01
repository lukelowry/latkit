/** Camera uniforms packed by the active projection each frame. */
export interface CameraRegion {
  /** Writes the 4x4 view-projection matrix into words 0..15. */
  setVP(m: Float32Array): void;
  /** Writes the camera position in projection/world space. */
  setCameraPos(x: number, y: number, z: number): void;
  /** Perspective field-of-view scale used by billboard sizing. */
  fovScale: number;
  /**
   * Writes the view matrix's right and up rows into words 92..98.
   *
   * Shaders derive the look direction as up x right, so the per-fragment ray
   * basis always matches the exact matrix the VP was built from.
   */
  setViewBasis(view: Float32Array): void;
  /** Scene depth blend: 0 at orthographic flat rest, 1 for full 3D depth. */
  depthMix: number;
  /** Flat projection x scale. */
  flatSx: number;
  /** Flat projection y scale. */
  flatSy: number;
  /** Flat projection x translation. */
  flatTx: number;
  /** Flat projection y translation. */
  flatTy: number;
}

/** World lighting uniforms owned by daylight state and display options. */
export interface LightRegion {
  /** Writes the normalized sun direction for daylight shading. */
  setDir(x: number, y: number, z: number): void;
  /** Display flag bitmask (daylight, graticule, geographic) shared with uniforms.wgsl. */
  flags: number;
  /** Minimum overlay brightness on the night side. */
  nightFloor: number;
  /** Width of the daylight terminator blend band. */
  terminatorWidth: number;
  /** Minimum opaque-surface brightness on the night side. */
  surfaceNightFloor: number;
}

/** Per-frame uniforms that change with canvas size. */
interface FrameRegion {
  /** Viewport width in device pixels. */
  viewportX: number;
  /** Viewport height in device pixels. */
  viewportY: number;
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
  /** Float-word offset for vertexVisible channel storage. */
  vVisibleOffset: number;
  /** Float-word offset for edgeVisible channel storage. */
  eVisibleOffset: number;
  /** Enabled raw item-channel flags shared with shaders and picking. */
  itemFlags: number;
}

/** CPU-side view of the packed uniform buffer shared with WGSL. */
export interface Uniforms {
  /** Backing buffer uploaded wholesale to the GPU each frame. */
  readonly raw: ArrayBuffer;
  /** Cached floating-point view over {@link Uniforms.raw}. */
  readonly rawF32: Float32Array;
  /** Cached signed 32-bit view over {@link Uniforms.raw}. */
  readonly rawI32: Int32Array;
  /** Cached unsigned 32-bit view over {@link Uniforms.raw}. */
  readonly rawU32: Uint32Array;
  /** Camera uniform accessors, packed by the active projection. */
  readonly camera: CameraRegion;
  /** World-lighting uniform accessors. */
  readonly light: LightRegion;
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
export const UNIFORM_BUFFER_BYTES = 416;

/** Display flag bit for daylight shading; must match uniforms.wgsl. */
export const FLAG_DAYLIGHT = 1;
/** Display flag bit for graticule rendering; must match uniforms.wgsl. */
export const FLAG_GRATICULE = 2;
/**
 * Display flag bit for geographic coordinates; must match uniforms.wgsl.
 *
 * Set whenever the loaded topology reads as lon/lat degrees (`isGeographic`).
 * The plane background clips its ground to the world rect on this bit.
 */
export const FLAG_GEOGRAPHIC = 4;
/** Focus flag bit that enables hover/selection rendering. */
export const FLAG_FOCUS_ENABLED = 1;
/** Focus flag bit that includes selected edge endpoints. */
export const FLAG_FOCUS_SELECTED_ENDPOINTS = 2;
/** Focus flag bit that includes hovered edge endpoints. */
export const FLAG_FOCUS_HOVER_ENDPOINTS = 4;
/** Item flag bit for an enabled vertexVisible channel. */
export const ITEM_VERTEX_VISIBLE = 1;
/** Item flag bit for an enabled edgeVisible channel. */
export const ITEM_EDGE_VISIBLE = 2;

/** WGSL uniform-address-space size and alignment per representable type. */
const WGSL_TYPES = {
  f32: { size: 4, align: 4 },
  u32: { size: 4, align: 4 },
  i32: { size: 4, align: 4 },
  vec2f: { size: 8, align: 8 },
  vec3f: { size: 12, align: 16 },
  vec4f: { size: 16, align: 16 },
  vec4i: { size: 16, align: 16 },
  mat4x4f: { size: 64, align: 16 },
} as const;

/** WGSL member types representable in the uniform layout table. */
type WgslType = keyof typeof WGSL_TYPES;

/** Region objects that carry generated scalar accessors. */
type RegionName = 'camera' | 'light' | 'frame' | 'geometry' | 'focus' | 'channel';

/** Typed-array view a scalar accessor reads and writes through. */
type ViewKey = 'f' | 'i' | 'u';

/** One scalar accessor generated onto a region object. */
interface UniformAccessor {
  readonly region: RegionName;
  readonly key: string;
  readonly view: ViewKey;
  /** Word lane within a multi-word field; defaults to 0. */
  readonly lane?: number;
}

/** One WGSL struct member with its asserted word offset. */
interface UniformField {
  /** WGSL member name, matching shaders/common/uniforms.wgsl. */
  readonly name: string;
  readonly type: WgslType;
  /** Explicit 4-byte-word offset; the validator proves WGSL agrees. */
  readonly word: number;
  readonly accessors?: readonly UniformAccessor[];
  /** Initial per-lane word values written by createUniforms; default zero. */
  readonly init?: readonly number[];
}

/** Shorthand for the common single-scalar accessor. */
const a = (region: RegionName, key: string, view: ViewKey = 'f'): readonly UniformAccessor[] => [
  { region, key, view },
];

/**
 * Single source of truth for the packed uniform layout. Field order and
 * types MUST match `struct Uniforms` in shaders/common/uniforms.wgsl; the
 * validator below proves each declared word offset is the one WGSL assigns,
 * and the parity unit test pins the .wgsl struct text to this table.
 */
export const UNIFORM_LAYOUT: readonly UniformField[] = [
  { name: 'vp', type: 'mat4x4f', word: 0 },
  { name: 'camera_pos', type: 'vec3f', word: 16 },
  { name: 'fov_scale', type: 'f32', word: 19, accessors: a('camera', 'fovScale') },
  { name: 'light_dir', type: 'vec3f', word: 20 },
  { name: 'flags', type: 'u32', word: 23, accessors: a('light', 'flags', 'u') },
  { name: 'flat_sx', type: 'f32', word: 24, accessors: a('camera', 'flatSx') },
  { name: 'flat_sy', type: 'f32', word: 25, accessors: a('camera', 'flatSy') },
  { name: 'flat_tx', type: 'f32', word: 26, accessors: a('camera', 'flatTx') },
  { name: 'flat_ty', type: 'f32', word: 27, accessors: a('camera', 'flatTy') },
  {
    name: 'viewport',
    type: 'vec2f',
    word: 28,
    accessors: [
      { region: 'frame', key: 'viewportX', view: 'f' },
      { region: 'frame', key: 'viewportY', view: 'f', lane: 1 },
    ],
  },
  { name: 'vertex_size', type: 'f32', word: 30, accessors: a('geometry', 'vertexSize') },
  { name: 'vertex_lod', type: 'f32', word: 31, accessors: a('geometry', 'vertexLod') },
  { name: 'base_edge_width', type: 'f32', word: 32, accessors: a('geometry', 'baseEdgeWidth') },
  { name: 'dash_period', type: 'f32', word: 33, accessors: a('geometry', 'dashPeriod') },
  {
    name: 'height_world_scale',
    type: 'f32',
    word: 34,
    accessors: a('geometry', 'heightWorldScale'),
  },
  {
    name: 'hover_vertex',
    type: 'i32',
    word: 35,
    accessors: a('focus', 'hoverVertex', 'i'),
    init: [-1],
  },
  {
    name: 'hover_edge',
    type: 'i32',
    word: 36,
    accessors: a('focus', 'hoverEdge', 'i'),
    init: [-1],
  },
  {
    name: 'selected_vertex',
    type: 'i32',
    word: 37,
    accessors: a('focus', 'selectedVertex', 'i'),
    init: [-1],
  },
  {
    name: 'selected_edge',
    type: 'i32',
    word: 38,
    accessors: a('focus', 'selectedEdge', 'i'),
    init: [-1],
  },
  { name: 'v_color_offset', type: 'u32', word: 39, accessors: a('channel', 'vColorOffset', 'u') },
  { name: 'e_color_offset', type: 'u32', word: 40, accessors: a('channel', 'eColorOffset', 'u') },
  { name: 'e_dash_offset', type: 'u32', word: 41, accessors: a('channel', 'eDashOffset', 'u') },
  { name: 'v_height_offset', type: 'u32', word: 42, accessors: a('channel', 'vHeightOffset', 'u') },
  { name: 'v_color_mode', type: 'u32', word: 43, accessors: a('channel', 'vColorMode', 'u') },
  { name: 'v_color_min', type: 'f32', word: 44, accessors: a('channel', 'vColorMin') },
  { name: 'v_color_scale', type: 'f32', word: 45, accessors: a('channel', 'vColorScale') },
  { name: 'e_color_mode', type: 'u32', word: 46, accessors: a('channel', 'eColorMode', 'u') },
  { name: 'e_color_min', type: 'f32', word: 47, accessors: a('channel', 'eColorMin') },
  { name: 'e_color_scale', type: 'f32', word: 48, accessors: a('channel', 'eColorScale') },
  { name: 'height_center', type: 'f32', word: 49, accessors: a('channel', 'heightCenter') },
  { name: 'height_scale', type: 'f32', word: 50, accessors: a('channel', 'heightScale') },
  { name: 'v_height_mode', type: 'u32', word: 51, accessors: a('channel', 'vHeightMode', 'u') },
  { name: 'v_size_offset', type: 'u32', word: 52, accessors: a('channel', 'vSizeOffset', 'u') },
  { name: 'v_size_mode', type: 'u32', word: 53, accessors: a('channel', 'vSizeMode', 'u') },
  { name: 'v_size_min', type: 'f32', word: 54, accessors: a('channel', 'vSizeMin') },
  { name: 'v_size_scale', type: 'f32', word: 55, accessors: a('channel', 'vSizeScale') },
  { name: 'focus_hover_color', type: 'u32', word: 56, accessors: a('focus', 'hoverColor', 'u') },
  {
    name: 'focus_selected_color',
    type: 'u32',
    word: 57,
    accessors: a('focus', 'selectedColor', 'u'),
  },
  { name: 'focus_flags', type: 'u32', word: 58, accessors: a('focus', 'flags', 'u') },
  { name: 'focus_hover_alpha', type: 'f32', word: 59, accessors: a('focus', 'hoverAlpha') },
  { name: 'focus_selected_alpha', type: 'f32', word: 60, accessors: a('focus', 'selectedAlpha') },
  {
    name: 'focus_vertex_hover_underlay_px',
    type: 'f32',
    word: 61,
    accessors: a('focus', 'vertexHoverUnderlayPx'),
  },
  {
    name: 'focus_vertex_selected_underlay_px',
    type: 'f32',
    word: 62,
    accessors: a('focus', 'vertexSelectedUnderlayPx'),
  },
  {
    name: 'focus_edge_hover_underlay_px',
    type: 'f32',
    word: 63,
    accessors: a('focus', 'edgeHoverUnderlayPx'),
  },
  {
    name: 'focus_edge_selected_underlay_px',
    type: 'f32',
    word: 64,
    accessors: a('focus', 'edgeSelectedUnderlayPx'),
  },
  { name: 'height_out_min', type: 'f32', word: 65, accessors: a('channel', 'heightOutMin') },
  { name: 'height_out_scale', type: 'f32', word: 66, accessors: a('channel', 'heightOutScale') },
  { name: 'focus_endpoint_ids', type: 'vec4i', word: 68, init: [-1, -1, -1, -1] },
  { name: 'base_vertex_color', type: 'vec4f', word: 72 },
  { name: 'grid_color', type: 'vec4f', word: 76 },
  { name: 'surface_color', type: 'vec4f', word: 80 },
  { name: 'border_color', type: 'vec4f', word: 84 },
  {
    name: 'backing_scale',
    type: 'f32',
    word: 88,
    accessors: a('frame', 'backingScale'),
    init: [1],
  },
  { name: 'night_floor', type: 'f32', word: 89, accessors: a('light', 'nightFloor') },
  { name: 'terminator_width', type: 'f32', word: 90, accessors: a('light', 'terminatorWidth') },
  {
    name: 'surface_night_floor',
    type: 'f32',
    word: 91,
    accessors: a('light', 'surfaceNightFloor'),
  },
  { name: 'camera_right', type: 'vec3f', word: 92 },
  { name: 'depth_mix', type: 'f32', word: 95, accessors: a('camera', 'depthMix') },
  { name: 'camera_up', type: 'vec3f', word: 96 },
  { name: 'item_flags', type: 'u32', word: 99, accessors: a('channel', 'itemFlags', 'u') },
  {
    name: 'v_visible_offset',
    type: 'u32',
    word: 100,
    accessors: a('channel', 'vVisibleOffset', 'u'),
  },
  {
    name: 'e_visible_offset',
    type: 'u32',
    word: 101,
    accessors: a('channel', 'eVisibleOffset', 'u'),
  },
];

/**
 * Natural-layout walk proving each declared offset is the one WGSL derives
 * from field order and alignment, and that the struct rounds to
 * {@link UNIFORM_BUFFER_BYTES}.
 */
function validateLayout(fields: readonly UniformField[]): void {
  let cursor = 0;
  for (const field of fields) {
    const { size, align } = WGSL_TYPES[field.type];
    cursor = Math.ceil(cursor / align) * align;
    if (cursor !== field.word * 4) {
      throw new Error(
        `uniform layout: ${field.name} declared at byte ${field.word * 4}, WGSL packs it at ${cursor}`,
      );
    }
    cursor += size;
  }
  const total = Math.ceil(cursor / 16) * 16;
  if (total !== UNIFORM_BUFFER_BYTES) {
    throw new Error(`uniform layout: struct rounds to ${total} bytes, not ${UNIFORM_BUFFER_BYTES}`);
  }
}
validateLayout(UNIFORM_LAYOUT);

/** Word offset of a named layout field. */
function wordOf(name: string): number {
  const field = UNIFORM_LAYOUT.find((entry) => entry.name === name);
  if (!field) throw new Error(`uniform layout: no field named ${name}`);
  return field.word;
}

// Word offsets derived from the layout table for raw-view consumers
// (pick/project.ts, pick/picker.ts, webgpu/renderer.ts, tests).
export const W_CAMERA_X = wordOf('camera_pos');
export const W_CAMERA_Y = W_CAMERA_X + 1;
export const W_CAMERA_Z = W_CAMERA_X + 2;
export const W_FOV_SCALE = wordOf('fov_scale');
export const W_FLAT_SX = wordOf('flat_sx');
export const W_FLAT_SY = wordOf('flat_sy');
export const W_FLAT_TX = wordOf('flat_tx');
export const W_FLAT_TY = wordOf('flat_ty');
export const W_VIEWPORT_X = wordOf('viewport');
export const W_VIEWPORT_Y = W_VIEWPORT_X + 1;
export const W_BACKING_SCALE = wordOf('backing_scale');
export const W_VERTEX_SIZE = wordOf('vertex_size');
export const W_VERTEX_LOD = wordOf('vertex_lod');
export const W_BASE_EDGE_WIDTH = wordOf('base_edge_width');
export const W_DASH_PERIOD = wordOf('dash_period');
export const W_HEIGHT_WORLD_SCALE = wordOf('height_world_scale');
export const W_HOVER_VERTEX = wordOf('hover_vertex');
export const W_HOVER_EDGE = wordOf('hover_edge');
export const W_SELECTED_VERTEX = wordOf('selected_vertex');
export const W_SELECTED_EDGE = wordOf('selected_edge');
export const W_HEIGHT_CENTER = wordOf('height_center');
export const W_HEIGHT_SCALE = wordOf('height_scale');
export const W_V_HEIGHT_MODE = wordOf('v_height_mode');
export const W_V_SIZE_MODE = wordOf('v_size_mode');
export const W_V_SIZE_MIN = wordOf('v_size_min');
export const W_V_SIZE_SCALE = wordOf('v_size_scale');
export const W_FOCUS_FLAGS = wordOf('focus_flags');
export const W_HEIGHT_OUT_MIN = wordOf('height_out_min');
export const W_HEIGHT_OUT_SCALE = wordOf('height_out_scale');
export const W_HOVER_ENDPOINT_A = wordOf('focus_endpoint_ids');
export const W_HOVER_ENDPOINT_B = W_HOVER_ENDPOINT_A + 1;
export const W_SELECTED_ENDPOINT_A = W_HOVER_ENDPOINT_A + 2;
export const W_SELECTED_ENDPOINT_B = W_HOVER_ENDPOINT_A + 3;
export const W_DEPTH_MIX = wordOf('depth_mix');
export const W_ITEM_FLAGS = wordOf('item_flags');

const W_LIGHT = wordOf('light_dir');
const W_CAMERA_RIGHT = wordOf('camera_right');
const W_CAMERA_UP = wordOf('camera_up');

/** Tests whether the vertexHeight channel mode is active in a raw uniform view. */
export function hasVertexHeightChannel(u: Uint32Array): boolean {
  return u[W_V_HEIGHT_MODE] !== 0;
}

/**
 * Tests whether the rendered scene has 3D depth.
 *
 * True whenever the camera left the orthographic flat state; the globe
 * always packs full depth.
 */
export function hasSceneDepth(f: Float32Array): boolean {
  return f[W_DEPTH_MIX]! > 0;
}

/** Allocates a zeroed uniform buffer and typed region accessors over it. */
export function createUniforms(): Uniforms {
  const buf = new ArrayBuffer(UNIFORM_BUFFER_BYTES);
  const f = new Float32Array(buf);
  const i = new Int32Array(buf);
  const u = new Uint32Array(buf);
  const views = { f, i, u } as const;

  // Scalar accessors are generated straight off the layout table; the unit
  // test exercises every region property, so a table/interface mismatch
  // cannot survive the suite despite the casts below.
  const regions: Record<RegionName, Record<string, unknown>> = {
    camera: {},
    light: {},
    frame: {},
    geometry: {},
    focus: {},
    channel: {},
  };
  for (const field of UNIFORM_LAYOUT) {
    for (const acc of field.accessors ?? []) {
      const view = views[acc.view];
      const at = field.word + (acc.lane ?? 0);
      Object.defineProperty(regions[acc.region], acc.key, {
        enumerable: true,
        get: () => view[at],
        set: (value: number) => {
          view[at] = value;
        },
      });
    }
    if (field.init) {
      const view =
        field.type === 'i32' || field.type === 'vec4i' ? i : field.type === 'u32' ? u : f;
      field.init.forEach((value, lane) => {
        view[field.word + lane] = value;
      });
    }
  }

  // Multi-word writers stay hand-rolled on top of the generated scalars.
  Object.assign(regions.camera, {
    setVP(m: Float32Array) {
      f.set(m.subarray(0, 16), 0);
    },
    setCameraPos(x: number, y: number, z: number) {
      f[W_CAMERA_X] = x;
      f[W_CAMERA_Y] = y;
      f[W_CAMERA_Z] = z;
    },
    setViewBasis(view: Float32Array) {
      f[W_CAMERA_RIGHT] = view[0]!;
      f[W_CAMERA_RIGHT + 1] = view[4]!;
      f[W_CAMERA_RIGHT + 2] = view[8]!;
      f[W_CAMERA_UP] = view[1]!;
      f[W_CAMERA_UP + 1] = view[5]!;
      f[W_CAMERA_UP + 2] = view[9]!;
    },
  });
  Object.assign(regions.light, {
    setDir(x: number, y: number, z: number) {
      f[W_LIGHT] = x;
      f[W_LIGHT + 1] = y;
      f[W_LIGHT + 2] = z;
    },
  });
  Object.assign(regions.focus, {
    setEndpointIds(hoverA: number, hoverB: number, selectedA: number, selectedB: number) {
      i[W_HOVER_ENDPOINT_A] = hoverA;
      i[W_HOVER_ENDPOINT_B] = hoverB;
      i[W_SELECTED_ENDPOINT_A] = selectedA;
      i[W_SELECTED_ENDPOINT_B] = selectedB;
    },
  });

  const vec4View = (name: string): Float32Array =>
    new Float32Array(buf, wordOf(name) * Float32Array.BYTES_PER_ELEMENT, 4);

  return {
    raw: buf,
    rawF32: f,
    rawI32: i,
    rawU32: u,
    camera: regions.camera as unknown as CameraRegion,
    light: regions.light as unknown as LightRegion,
    frame: regions.frame as unknown as FrameRegion,
    geometry: regions.geometry as unknown as GeometryRegion,
    focus: regions.focus as unknown as FocusRegion,
    channel: regions.channel as unknown as ChannelRegion,
    baseVertexColor: vec4View('base_vertex_color'),
    gridColor: vec4View('grid_color'),
    surfaceColor: vec4View('surface_color'),
    borderColor: vec4View('border_color'),
  };
}
