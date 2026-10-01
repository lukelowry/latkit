// The grid pass: dots at grid points under everything, one fullscreen triangle. The finest level
// shown is the grid pitch times the smallest power of four whose dots sit at least
// GRID_MIN_SPACING_PX apart on screen; it fades in up to GRID_FULL_SPACING_PX while the level four
// times coarser, a subset of its dots, draws in full.

struct VOut {
  @builtin(position) pos: vec4f,
  // Normalized device coordinates, interpolated: exact even while the backing store is quantized.
  @location(0) ndc: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  // (-1, -1), (3, -1), (-1, 3): one triangle covering the viewport.
  let x = f32((vi << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(vi & 2u) * 2.0 - 1.0;
  var out: VOut;
  out.pos = vec4f(x, y, 0.0, 1.0);
  out.ndc = vec2f(x, y);
  return out;
}

// Coverage of the dots of a level `spacing` diagram units apart, at diagram point `p`.
fn grid_dots(p: vec2f, spacing: f32) -> f32 {
  let q = p - spacing * round(p / spacing);
  return aa(px(length(q)) - GRID_DOT_RADIUS_PX);
}

@fragment
fn fs(v: VOut) -> @location(0) vec4f {
  let pitch_px = px(u.grid_pitch);
  if (!display(DISPLAY_GRID) || u.grid_pitch <= 0.0 || pitch_px <= 0.0) {
    return vec4f(0.0);
  }
  let css = vec2f(v.ndc.x + 1.0, 1.0 - v.ndc.y) * 0.5 * viewport_css();
  let p = from_screen(css);
  // Powers of four the pitch needs to reach the minimum spacing: log4 by halving log2.
  let level = max(ceil(0.5 * log2(GRID_MIN_SPACING_PX / pitch_px)), 0.0);
  let fine = u.grid_pitch * exp2(2.0 * level);
  let fade = smoothstep(GRID_MIN_SPACING_PX, GRID_FULL_SPACING_PX, px(fine));
  let coverage = max(grid_dots(p, fine) * fade, grid_dots(p, 4.0 * fine));
  return premultiply(layer(u.grid_color, coverage));
}
