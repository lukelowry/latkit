struct Uniforms {
  view: vec4f,
  pose: vec4f,
  rotation: vec4f,
  geo: vec4f,
  center: vec4f,
  /** The dash period in CSS pixels, and whether markers draw. */
  style: vec4f,
  hoverColor: vec4f,
  selectedColor: vec4f,
  halo: vec4f,
  pointer: vec4f,
  sun: vec4f,
  surface: vec4f,
  grid: vec4f,
  flags: vec4u,
  /** The view's background: the halo labels draw over lines. */
  background: vec4f,
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
fn daylight(normal: vec3f, u: Uniforms) -> f32 {
  if (u.sun.w < 0.5) { return 1.0; }
  return mix(u.pointer.z, 1.0, smoothstep(-u.pointer.w, u.pointer.w, dot(normal, u.sun.xyz)));
}
