// Flat background: affine-inverted Cartesian grid overlay.
// Prepended at pipeline creation: uniforms.wgsl + graticule.wgsl.
// Renders a full-screen triangle. Early-discards when graticule is off.

@vertex
fn vs(@builtin(vertex_index) vid: u32) -> @builtin(position) vec4f {
  let x = f32(vid % 2u) * 4.0 - 1.0;
  let y = f32(vid / 2u) * 4.0 - 1.0;
  return vec4f(x, y, 0.5, 1.0);
}

struct ColorOut {
  @location(0) color: vec4f,
}

fn flat_bg_color(frag_pos: vec4f) -> vec4f {
  // Early discard when graticule is off -- u.flags is uniform so all
  // invocations branch the same way (no derivative issues).
  if (!grid_enabled()) { discard; }

  // Invert flat affine transform: clip -> world coordinates.
  let ndc = vec2f(
    frag_pos.x / u.viewport.x * 2.0 - 1.0,
    1.0 - frag_pos.y / u.viewport.y * 2.0,
  );
  let coord = vec2f(
    (ndc.x - u.flat_tx) / u.flat_sx,
    (ndc.y - u.flat_ty) / u.flat_sy,
  );

  let grid = cartesian_grid(coord);
  if (grid < 0.001) { discard; }

  return vec4f(u.grid_color.rgb, grid);
}

@fragment
fn fs_color(@builtin(position) frag_pos: vec4f) -> ColorOut {
  return ColorOut(flat_bg_color(frag_pos));
}
