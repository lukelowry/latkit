// Per-fragment eye ray for background surface traces.
//
// The basis arrives packed from the camera (view-matrix right/up rows);
// look is their cross product, so plane and globe share one helper and no
// shader rebuilds a basis from camera_pos. Basis stability at the poles and
// nadir is the camera's job, not this file's. The two backgrounds differ
// only in the ray-surface intersection they run on the result.
fn camera_ray(frag_xy: vec2f) -> vec3f {
  let ndc = vec2f(
    frag_xy.x / u.viewport.x * 2.0 - 1.0,
    1.0 - frag_xy.y / u.viewport.y * 2.0,
  );
  let fwd = cross(u.camera_up, u.camera_right);
  let aspect = u.viewport.x / u.viewport.y;
  return normalize(
    fwd +
    u.camera_right * (ndc.x * u.fov_scale * aspect) +
    u.camera_up * (ndc.y * u.fov_scale),
  );
}
