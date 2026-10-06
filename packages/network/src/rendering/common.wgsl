struct Uniforms {
  view: vec4f,
  pose: vec4f,
  rotation: vec4f,
  geo: vec4f,
  center: vec4f,
  hoverColor: vec4f,
  selectedColor: vec4f,
  halo: vec4f,
  pointer: vec4f,
  sun: vec4f,
  surface: vec4f,
  grid: vec4f,
  flags: vec4u,
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
}
fn project_world(p: vec3f, u: Uniforms) -> vec4f {
  let rx = p.x * u.rotation.x + p.y * u.rotation.y;
  let ry = -p.x * u.rotation.y + p.y * u.rotation.x;
  let distance = u.pose.y;
  if (u.view.w < 0.5) {
    return vec4f(rx * u.pose.x * 2.0 / u.view.x, ry * u.pose.x * 2.0 / u.view.y, 0.5 - p.z / (distance * 4.0), 1.0);
  }
  let w = distance + ry * u.rotation.w - p.z * u.rotation.z;
  let y = ry * u.rotation.z + p.z * u.rotation.w;
  let depth = (w - distance * 0.001) / (1.0 - 0.001 / 1000.0);
  return vec4f(rx * u.pose.x * distance * 2.0 / u.view.x, y * u.pose.x * distance * 2.0 / u.view.y, depth, w);
}
/** Where the view's ray through `ndc` meets the globe, in the world; a w of 0 where it misses. */
fn globePoint(ndc: vec2f, u: Uniforms) -> vec4f {
  let right = vec3f(u.rotation.x, u.rotation.y, 0.0);
  let up = vec3f(-u.rotation.y * u.rotation.z, u.rotation.x * u.rotation.z, u.rotation.w);
  let front = vec3f(u.rotation.y * u.rotation.w, -u.rotation.x * u.rotation.w, u.rotation.z);
  let eye = front * u.pose.y;
  let direction = right * ndc.x * u.view.x / (2.0 * u.pose.x) + up * ndc.y * u.view.y / (2.0 * u.pose.x) - front * u.pose.y;
  let oc = eye - vec3f(0.0, 0.0, -1.0);
  let a = dot(direction, direction);
  let b = dot(oc, direction);
  let disc = b * b - a * (dot(oc, oc) - 1.0);
  if (disc < 0.0) { return vec4f(0.0); }
  let t = (-b - sqrt(disc)) / a;
  if (t < 0.0) { return vec4f(0.0); }
  return vec4f(eye + direction * t, 1.0);
}
/**
 * A billboard's depth at a fragment: its own, but on a globe never behind the surface under it,
 * which bulges toward the camera across a marker or a label and would cut it.
 */
fn billboardDepth(position: vec4f, u: Uniforms) -> f32 {
  if (u.view.w < 1.5) { return position.z; }
  let size = u.view.xy * u.view.z;
  let hit = globePoint(vec2f(position.x / size.x * 2.0 - 1.0, 1.0 - position.y / size.y * 2.0), u);
  if (hit.w == 0.0) { return position.z; }
  let clip = project_world(hit.xyz, u);
  return min(position.z, max(clip.z / clip.w - 0.000001, 0.0));
}
fn daylight(normal: vec3f, u: Uniforms) -> f32 {
  if (u.sun.w < 0.5) { return 1.0; }
  return mix(u.pointer.z, 1.0, smoothstep(-u.pointer.w, u.pointer.w, dot(normal, u.sun.xyz)));
}
