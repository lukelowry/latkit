// Shared uniform struct, prepended to all shader modules at pipeline creation time.
// Total: 400 bytes (25 x 16, naturally aligned).

struct Uniforms {
  // Projection (bytes 0-111)
  vp: mat4x4f,
  camera_pos: vec3f,
  fov_scale: f32,
  light_dir: vec3f,
  flags: u32,
  flat_sx: f32,
  flat_sy: f32,
  flat_tx: f32,
  flat_ty: f32,

  // Frame (bytes 112-123)
  viewport: vec2f,
  time: f32,

  // Geometry (bytes 124-143)
  vertex_size: f32,
  vertex_lod: f32,
  base_edge_width: f32,
  dash_period: f32,
  height_world_scale: f32,

  // Interaction (bytes 144-159)
  hover_vertex: i32,
  hover_edge: i32,
  selected_vertex: i32,
  selected_edge: i32,

  // Channel buffer addressing + normalization (bytes 160-227)
  v_color_offset: u32,
  e_color_offset: u32,
  e_dash_offset: u32,
  v_height_offset: u32,
  v_color_mode: u32,
  v_color_min: f32,
  v_color_scale: f32,
  e_color_mode: u32,
  e_color_min: f32,
  e_color_scale: f32,
  height_center: f32,
  height_scale: f32,
  v_height_mode: u32,
  v_size_offset: u32,
  v_size_mode: u32,
  v_size_min: f32,
  v_size_scale: f32,

  // Focus style (bytes 228-287)
  focus_hover_color: u32,
  focus_selected_color: u32,
  focus_flags: u32,
  focus_hover_alpha: f32,
  focus_selected_alpha: f32,
  focus_vertex_hover_underlay_px: f32,
  focus_vertex_selected_underlay_px: f32,
  focus_edge_hover_underlay_px: f32,
  focus_edge_selected_underlay_px: f32,
  // Height output range (bytes 264-271): normalized domain t maps to
  // height_out_min + t * height_out_scale.
  height_out_min: f32,
  height_out_scale: f32,
  // xy = hovered edge endpoints, zw = selected edge endpoints.
  focus_endpoint_ids: vec4i,

  // Base vertex color (bytes 288-303)
  base_vertex_color: vec4f,

  // Background theme (bytes 304-351): the app's design tokens for the renderer's opaque geometry,
  // projected in so globe/tilt surfaces, the graticule and the geographic borders track the app
  // theme instead of hardcoded constants. The void/sky is NOT here - it stays a transparent clear so
  // the themed DOM bleeds through (see renderer.ts).
  // grid_color    - the shared graticule line color.
  // surface_color - the tilt ground plane and globe sphere base tone.
  // border_color  - the geographic border tint (coastlines/admin lines); per-tier alpha in borders.wgsl.
  grid_color: vec4f,
  surface_color: vec4f,
  border_color: vec4f,

  // Presentation scale and day/night controls (bytes 352-367).
  // backing_scale      - actual backing pixels per CSS pixel after device-limit fitting.
  // night_floor        - overlay floor (vertices/edges/poles/graticule). Tuned for legibility.
  // terminator_width   - width of the day/night transition band.
  // surface_night_floor - opaque-surface floor, tuned independently for atmospheric darkness.
  backing_scale: f32,
  night_floor: f32,
  terminator_width: f32,
  surface_night_floor: f32,

  // Planar camera basis (bytes 368-383).
  // (look_x, look_y, sin(bearing), cos(bearing)): the bg derives its
  // per-fragment ray basis from these because the globe's normalize(-cam)
  // trick assumes a look-at-origin Y-up camera, and a naive look-at basis
  // degenerates at nadir. right = (cos b, sin b, 0) is stable everywhere.
  plane_params: vec4f,

  // Flat-to-tilt projection blend (bytes 384-399).
  plane_mix: f32,
  _plane_pad_0: f32,
  _plane_pad_1: f32,
  _plane_pad_2: f32,
}

@group(0) @binding(0) var<uniform> u: Uniforms;

fn css_px(value: f32) -> f32 {
  return value * u.backing_scale;
}

const FLAG_DAYLIGHT:  u32 = 1u;
const FLAG_GRATICULE: u32 = 2u;

const FOCUS_ENABLED:            u32 = 1u;
const FOCUS_SELECTED_ENDPOINTS: u32 = 2u;
const FOCUS_HOVER_ENDPOINTS:    u32 = 4u;

const ID_KIND_VERTEX: u32 = 1u;
const ID_KIND_EDGE:   u32 = 2u;

const ROLE_BASE:  u32 = 0u;
const ROLE_FOCUS: u32 = 1u;
const ROLE_HALO:  u32 = 2u;

// Small semantic biases sit on top of height-derived depth.
const Z_BIAS_VERTEX_BAND_OFFSET : f32 = -2.0e-6;
const Z_BIAS_EDGE_BAND_OFFSET   : f32 = -1.0e-6;
const Z_BIAS_SELECTION_LIFT     : f32 =  5.0e-7;
const Z_BIAS_JITTER_AMPLITUDE   : f32 =  1.0e-7;

// Deterministic per-instance NDC jitter, bounded to -Z_BIAS_JITTER_AMPLITUDE.
// Tie-breaks primitives at literally identical depth.
fn jitter(i: u32) -> f32 {
  var h = i;
  h = ((h >> 16u) ^ h) * 0x45d9f3bu;
  h = ((h >> 16u) ^ h) * 0x45d9f3bu;
  h = (h >> 16u) ^ h;
  return -f32(h & 0xFFFu) * (Z_BIAS_JITTER_AMPLITUDE / 4096.0);
}

fn vertex_focus_state_for(id: i32) -> u32 {
  if ((u.focus_flags & FOCUS_ENABLED) == 0u) { return 0u; }
  if (id == u.selected_vertex) { return 2u; }
  if ((u.focus_flags & FOCUS_SELECTED_ENDPOINTS) != 0u &&
      (id == u.focus_endpoint_ids.z || id == u.focus_endpoint_ids.w)) { return 2u; }
  if (id == u.hover_vertex) { return 1u; }
  if ((u.focus_flags & FOCUS_HOVER_ENDPOINTS) != 0u &&
      (id == u.focus_endpoint_ids.x || id == u.focus_endpoint_ids.y)) { return 1u; }
  return 0u;
}

fn edge_focus_state_for(id: i32) -> u32 {
  if ((u.focus_flags & FOCUS_ENABLED) == 0u) { return 0u; }
  if (id == u.selected_edge) { return 2u; }
  if (id == u.hover_edge) { return 1u; }
  return 0u;
}
