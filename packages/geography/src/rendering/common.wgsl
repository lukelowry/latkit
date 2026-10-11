// What every pipeline binds first: the scene, which a hosting view hands over as its own; then the
// geography's look, written only as it changes.
struct Style {
  surface: vec4f,
  /** The grid's color; no alpha draws none. */
  gridColor: vec4f,
  /** The atmosphere's color; no alpha draws none. */
  atmosphere: vec4f,
  hover: vec4f,
  /** The selection's tint; a negative alpha keeps each item's own color. */
  selected: vec4f,
  /** How far hover's and the selection's glow reach past a line, the opacity of the unselected, and the dash period. */
  glow: vec4f,
  /** The label halo's color, and its reach in CSS pixels. */
  halo: vec4f,
  /** The globe's axis's color. */
  axis: vec4f,
  /** The comets' color. */
  flow: vec4f,
  /** How far apart comets run in CSS pixels, and the seconds they have moved for. */
  motion: vec4f,
  /** Where the grid's lines fall, as `gridLines` writes it. */
  grid: vec4f,
}
@group(0) @binding(0) var<uniform> scene: Scene;
@group(0) @binding(2) var<uniform> u: Style;
const NONE: u32 = 0xffffffffu;
const DEGREE: f32 = 0.017453292519943295;

/** How far a world point on the globe faces the eye: positive in front of the horizon. */
fn facingOf(world: vec3f) -> f32 {
  let q = scene.projection;
  if (q.view.w < 1.5) { return 1.0; }
  let cy = -q.rotation.w * q.pose.y;
  let cz = 1.0 + q.rotation.z * q.pose.y;
  return dot(world + vec3f(0.0, 0.0, 1.0), vec3f(-q.rotation.y * cy, q.rotation.x * cy, cz)) - 1.0;
}
/** How lit the ground is at a relative longitude and latitude. */
fn lightAt(relative: vec2f) -> f32 {
  if (scene.light.sun.w < 0.5) { return 1.0; }
  return projection_daylight(projection_normal(relative + scene.projection.center.xy), scene.light);
}
/** A straight color, premultiplied. */
fn premultiplied(color: vec4f) -> vec4f { return vec4f(color.rgb * color.a, color.a); }
