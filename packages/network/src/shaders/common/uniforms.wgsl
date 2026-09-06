// Shared uniform struct, prepended to all shader modules at pipeline creation time.
// Total: 464 bytes (29 x 16, naturally aligned).
//
// Naming: per-item words carry a `v_`/`e_` prefix; `_px` values are CSS pixels (scale with
// css_px); a bitmask is `<x>_flags` and its bits are `<X>_*`. Channel words map a raw value to a
// normalized t as `(x - min) * scale`, and an output range as `out_min + t * out_span`.

struct Uniforms {
  // Camera (packed by the active projection) plus world lighting (bytes 0-111).
  // light_dir is owned by daylight state (src/daylight.ts); display_flags ride its pad lane.
  view_proj: mat4x4f,
  camera_pos: vec3f,
  fov_scale: f32,
  light_dir: vec3f,
  display_flags: u32,
  flat_sx: f32,
  flat_sy: f32,
  flat_tx: f32,
  flat_ty: f32,

  // Frame (bytes 112-119): device pixels.
  viewport: vec2f,

  // Geometry (bytes 120-135)
  v_radius: f32,
  e_half_width: f32,
  e_dash_period_px: f32,
  height_amplitude: f32,

  // Focus ids (bytes 136-151): -1 when none.
  v_hover_id: i32,
  e_hover_id: i32,
  v_selected_id: i32,
  e_selected_id: i32,

  // Channel buffer addressing + normalization (bytes 152-219)
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
  v_height_min: f32,
  v_height_scale: f32,
  v_height_mode: u32,
  v_size_offset: u32,
  v_size_mode: u32,
  v_size_min: f32,
  v_size_scale: f32,

  // Focus style (bytes 220-283)
  hover_color: u32,
  selected_color: u32,
  focus_flags: u32,
  hover_alpha: f32,
  selected_alpha: f32,
  v_hover_px: f32,
  v_selected_px: f32,
  e_hover_px: f32,
  e_selected_px: f32,
  // Height output range (bytes 256-263).
  v_height_out_min: f32,
  v_height_out_span: f32,
  // xy = hovered edge endpoints, zw = selected edge endpoints.
  focus_endpoints: vec4i,

  // Resting vertex color without a vertexColor channel (bytes 288-303).
  v_base_color: vec4f,

  // Background theme (bytes 304-351): the app's design tokens for the renderer's opaque geometry,
  // projected in so globe/tilt surfaces, the graticule and the geographic borders track the app
  // theme instead of hardcoded constants. The void/sky is NOT here - it stays a transparent clear so
  // the themed DOM bleeds through (see renderer.ts).
  // graticule_color - the graticule line color.
  // surface_color   - the ground plane (flat/tilt) and globe sphere base tone.
  // border_color    - the geographic border tint (coastlines/admin lines); per-tier alpha in borders.wgsl.
  graticule_color: vec4f,
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

  // Camera basis (bytes 368-399): the active camera's view-matrix right and
  // up rows, packed by pack() beside view_proj/camera_pos. Ray helpers derive
  // look = cross(camera_up, camera_right); no shader rebuilds a basis from
  // camera_pos. Valid whenever depth_mix > 0, the same staleness contract
  // camera_pos carries - flat never reads it.
  // depth_mix (0 at orthographic flat rest, 1 for full 3D depth; the globe
  // always packs 1) and item_flags ride the vec3f pad lanes.
  camera_right: vec3f,
  depth_mix: f32,
  camera_up: vec3f,
  item_flags: u32,

  // Raw item-channel addressing (bytes 400-407).
  v_visible_offset: u32,
  e_visible_offset: u32,

  // Vertex size output range (bytes 408-415): radius multipliers.
  v_size_out_min: f32,
  v_size_out_span: f32,

  // Resting edge color (bytes 416-431), read only under DISPLAY_EDGE_BASE_COLOR.
  e_base_color: vec4f,

  // Pointer (bytes 432-439): canvas-local CSS px of the latest pointer, POINTER_NONE when absent.
  pointer_px: vec2f,

  // Shade channel addressing (bytes 440-447).
  v_shade_offset: u32,
  e_shade_offset: u32,

  // Position channel addressing (bytes 448-451): interleaved x, y per vertex, always bound.
  v_position_offset: u32,
}

@group(0) @binding(0) var<uniform> u: Uniforms;

fn css_px(value: f32) -> f32 {
  return value * u.backing_scale;
}

const DISPLAY_DAYLIGHT:        u32 = 1u;
const DISPLAY_GRATICULE:       u32 = 2u;
const DISPLAY_GEOGRAPHIC:      u32 = 4u;
const DISPLAY_EDGE_BASE_COLOR: u32 = 8u;
const DISPLAY_VERTICES:        u32 = 16u;

const FOCUS_ENABLED:            u32 = 1u;
const FOCUS_SELECTED_ENDPOINTS: u32 = 2u;
const FOCUS_HOVER_ENDPOINTS:    u32 = 4u;

const ITEM_VERTEX_VISIBLE: u32 = 1u;
const ITEM_EDGE_VISIBLE:   u32 = 2u;
const ITEM_VERTEX_SHADE:   u32 = 4u;
const ITEM_EDGE_SHADE:     u32 = 8u;

const ID_KIND_VERTEX: u32 = 1u;
const ID_KIND_EDGE:   u32 = 2u;

const ROLE_BASE:  u32 = 0u;
const ROLE_FOCUS: u32 = 1u;
const ROLE_HALO:  u32 = 2u;

// Small NDC biases that order items at identical depth: vertices over edges and poles, and a
// focused item over its unfocused neighbors. Items of one kind share one bias, so ties between
// them resolve in draw order under less-equal and their AA fringes blend instead of cutting.
const Z_BIAS_VERTEX_BAND_OFFSET : f32 = -2.0e-6;
const Z_BIAS_EDGE_BAND_OFFSET   : f32 = -1.0e-6;
const Z_BIAS_SELECTION_LIFT     : f32 =  5.0e-7;

fn z_bias(band: f32, focused: bool) -> f32 {
  return select(band, band - Z_BIAS_SELECTION_LIFT, focused);
}

fn vertex_focus_state_for(id: i32) -> u32 {
  if ((u.focus_flags & FOCUS_ENABLED) == 0u) { return 0u; }
  if (id == u.v_selected_id) { return 2u; }
  if ((u.focus_flags & FOCUS_SELECTED_ENDPOINTS) != 0u &&
      (id == u.focus_endpoints.z || id == u.focus_endpoints.w)) { return 2u; }
  if (id == u.v_hover_id) { return 1u; }
  if ((u.focus_flags & FOCUS_HOVER_ENDPOINTS) != 0u &&
      (id == u.focus_endpoints.x || id == u.focus_endpoints.y)) { return 1u; }
  return 0u;
}

fn edge_focus_state_for(id: i32) -> u32 {
  if ((u.focus_flags & FOCUS_ENABLED) == 0u) { return 0u; }
  if (id == u.e_selected_id) { return 2u; }
  if (id == u.e_hover_id) { return 1u; }
  return 0u;
}
