fn plane_ray(frag_xy: vec2f) -> vec3f {
  let ndc = vec2f(
    frag_xy.x / u.viewport.x * 2.0 - 1.0,
    1.0 - frag_xy.y / u.viewport.y * 2.0,
  );
  let look = vec3f(u.plane_params.xy, 0.0);
  let fwd = normalize(look - u.camera_pos);
  let right = vec3f(u.plane_params.w, u.plane_params.z, 0.0);
  let up = cross(right, fwd);
  let aspect = u.viewport.x / u.viewport.y;
  return normalize(fwd + right * ndc.x * u.fov_scale * aspect + up * ndc.y * u.fov_scale);
}
