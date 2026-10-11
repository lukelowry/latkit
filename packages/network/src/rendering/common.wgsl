struct Uniforms {
  /** The scene block, as `kit.Projector` writes it: the projection, then the light, which the ground beneath binds too. */
  view: vec4f,
  pose: vec4f,
  rotation: vec4f,
  geo: vec4f,
  center: vec4f,
  split: vec4f,
  /** The sun of the ground beneath, which dims what faces away from it. */
  light: Light,
  hoverColor: vec4f,
  /** Alpha -1 glows in each item's own color. */
  selectedColor: vec4f,
  /** How far hover's and the selection's glow reach, and the rest's opacity while something is selected. */
  glow: vec4f,
  /** What label halos match: the ground beneath, or the background. */
  halo: vec4f,
  flowColor: vec4f,
  /** How far the camera center moved, in the data's units, since `previous` was drawn. */
  easeShift: vec2f,
  /** How much of `previous` a transition still shows: 1 as it starts, 0 at rest. */
  ease: f32,
  /** Seconds since the last presented frame, which flow moves by; 0 for an exported frame. */
  dt: f32,
  dashPeriodPx: f32,
  edgeSpacingPx: f32,
  flowSpacingPx: f32,
  markers: u32,
  hoverScale: f32,
  labelHaloPx: f32,
  /** The vertex hover grows, and the one it left, by dense address; how far each has grown. */
  grown: vec2u,
  growth: vec2f,
  /** How much markers shrink at this zoom, and the least radius they shrink to, in CSS pixels. */
  markerFit: f32,
  vertexMinRadiusPx: f32,
}
/** How far toward the camera a focused row draws: over its neighbors, never past the globe. */
const FOCUS_LIFT: f32 = 0.00002;
/** How far labels draw toward the camera, over focused rows and their glow. */
const LABEL_LIFT: f32 = 0.00004;
fn projectionOf(u: Uniforms) -> Projection { return Projection(u.view, u.pose, u.rotation, u.geo, u.center, u.split); }
fn project_world(p: vec3f, u: Uniforms) -> vec4f { return projection_clip(p, projectionOf(u)); }
/** Where the view's ray through `ndc` meets the globe, in the world; a w of 0 where it misses. */
fn globePoint(ndc: vec2f, u: Uniforms) -> vec4f { return projection_globe_hit(ndc, projectionOf(u)); }
/** A billboard's depth at a fragment, never behind the globe's surface under it. */
fn billboardDepth(position: vec4f, u: Uniforms) -> f32 {
  return projection_billboard_depth(position, projectionOf(u), 0.0);
}
fn daylight(normal: vec3f, u: Uniforms) -> f32 { return projection_daylight(normal, u.light); }
