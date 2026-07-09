// Per-fragment ray basis from tilt_params. The camera looks at
// (look_x, look_y, 0) in a Z-up world, and right = (cos b, sin b, 0) stays
// stable through nadir where cross(fwd, world_up) collapses. Must match
// the view-matrix rows camera/tilt.ts builds.

fn tilt_ray_dir(frag_xy: vec2f) -> vec3f {
  let ndc = vec2f(
    frag_xy.x / u.viewport.x * 2.0 - 1.0,
    1.0 - frag_xy.y / u.viewport.y * 2.0,
  );
  let look = vec3f(u.tilt_params.xy, 0.0);
  let fwd = normalize(look - u.camera_pos);
  let right = vec3f(u.tilt_params.w, u.tilt_params.z, 0.0);
  let up = cross(right, fwd);
  let aspect = u.viewport.x / u.viewport.y;
  return normalize(fwd + right * ndc.x * u.fov_scale * aspect + up * ndc.y * u.fov_scale);
}
