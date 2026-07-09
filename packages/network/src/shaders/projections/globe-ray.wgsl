// Ray helpers for the globe background's per-fragment sphere trace. The bg
// writes the resulting surface depth via frag_depth; every overlay pass
// depth-tests against it, which is the sole sphere-occlusion mechanism.
// Overlays and background rendering share this same visual depth path.
// follows the same sphere depth as the visual pass.
fn globe_ray_dir_for_fragment(frag_xy: vec2f) -> vec3f {
  let ndc = vec2f(
    frag_xy.x / u.viewport.x * 2.0 - 1.0,
    1.0 - frag_xy.y / u.viewport.y * 2.0,
  );

  let cam = u.camera_pos;
  let fwd = normalize(-cam);
  let right = normalize(vec3f(cam.z, 0.0, -cam.x));
  let up = cross(right, fwd);
  let aspect = u.viewport.x / u.viewport.y;

  return normalize(fwd + right * ndc.x * u.fov_scale * aspect + up * ndc.y * u.fov_scale);
}

fn globe_ray_unit_sphere_t(ray_origin: vec3f, ray_dir: vec3f) -> f32 {
  let half_b = dot(ray_origin, ray_dir);
  let c = dot(ray_origin, ray_origin) - 1.0;
  let disc = half_b * half_b - c;
  if (disc < 0.0) { return -1.0; }

  let t = -half_b - sqrt(disc);
  if (t < 0.0) { return -1.0; }
  return t;
}
