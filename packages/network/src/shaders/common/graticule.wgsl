// Shared background grid helpers.
// Prepended to every background shader alongside uniforms.wgsl.
//
// Flat and tilt draw a Cartesian coordinate grid in projection/world units.
// Globe draws a geographic graticule in radians. They share line rendering,
// colors, and the graticule flag, but not the spacing model: a spherical
// longitude/latitude grid has antimeridian and pole constraints that a
// Cartesian decade grid does not.

const PI = 3.14159265358979;
const LOG2_10 = 3.32192809488736;
const INV_LOG2_10 = 0.301029995663981;

// The graticule line color is host-provided via u.grid_color (see uniforms.wgsl) so it tracks the
// app theme; background shaders read u.grid_color.rgb directly.
const GRID_CART_MIN_PX = 24.0;

const GRID_MINOR_WIDTH = 0.5;
const GRID_MAJOR_WIDTH = 0.75;
const GRID_REF_WIDTH = 1.0;

const GRID_MINOR_ALPHA = 0.10;
const GRID_MAJOR_ALPHA = 0.25;
const GRID_REF_ALPHA = 0.50;

const GEO_COARSE_SPACE = PI / 6.0;    // 30 degrees
const GEO_MID_SPACE = PI / 18.0;      // 10 degrees
const GEO_FINE_SPACE = PI / 180.0;    // 1 degree

fn grid_enabled() -> bool {
  return (u.flags & FLAG_GRATICULE) != 0u;
}

// Render one tier of gridlines at constant screen-space width.
//   dist     - coordinate-space distance to the nearest line
//   grad     - coordinate units per pixel along the steepest screen direction
//   width_px - half-width of the rendered line in pixels
//   spacing  - coordinate-space spacing between adjacent lines in this tier
//   alpha    - peak opacity for this tier
fn line_alpha(dist: f32, grad: f32, width_px: f32, spacing: f32, alpha: f32) -> f32 {
  let g = max(grad, 1e-6);
  let px_dist = dist / g;
  let core = 1.0 - smoothstep(width_px, width_px + 1.0, px_dist);
  let px_between_lines = spacing / g;
  let resolve = smoothstep(2.0, 5.0, px_between_lines);
  return core * resolve * alpha;
}

fn grid_dist(coord: f32, spacing: f32) -> f32 {
  return abs(fract(coord / spacing + 0.5) - 0.5) * spacing;
}

fn decade_ceil(x: f32) -> f32 {
  let exponent = ceil(log2(max(x, 1e-12)) * INV_LOG2_10);
  return exp2(exponent * LOG2_10);
}

fn cartesian_grid(coord: vec2f) -> f32 {
  if (!grid_enabled()) { return 0.0; }

  let gx = length(vec2f(dpdx(coord.x), dpdy(coord.x)));
  let gy = length(vec2f(dpdx(coord.y), dpdy(coord.y)));
  let g = max(max(gx, gy), 1e-12);

  let major = decade_ceil(g * GRID_CART_MIN_PX);
  let minor = major * 0.1;

  let major_alpha = max(
    line_alpha(grid_dist(coord.x, major), gx, GRID_MAJOR_WIDTH, major, GRID_MAJOR_ALPHA),
    line_alpha(grid_dist(coord.y, major), gy, GRID_MAJOR_WIDTH, major, GRID_MAJOR_ALPHA),
  );
  let minor_alpha = max(
    line_alpha(grid_dist(coord.x, minor), gx, GRID_MINOR_WIDTH, minor, GRID_MINOR_ALPHA),
    line_alpha(grid_dist(coord.y, minor), gy, GRID_MINOR_WIDTH, minor, GRID_MINOR_ALPHA),
  );
  let axis_alpha = max(
    line_alpha(abs(coord.x), gx, GRID_REF_WIDTH, major, GRID_REF_ALPHA),
    line_alpha(abs(coord.y), gy, GRID_REF_WIDTH, major, GRID_REF_ALPHA),
  );

  return max(max(major_alpha, minor_alpha), axis_alpha);
}

// Periodic angular gradient for longitude. Measuring the gradient of the
// unit circle avoids the +/-PI branch-cut spike from atan2().
fn angular_grad(a: f32) -> f32 {
  let c = cos(a);
  let s = sin(a);
  let gx = length(vec2f(dpdx(c), dpdx(s)));
  let gy = length(vec2f(dpdy(c), dpdy(s)));
  return length(vec2f(gx, gy));
}

fn geo_tier(lon: f32, lat: f32, grad_lon: f32, grad_lat: f32, spacing: f32, width_px: f32, alpha: f32) -> f32 {
  return max(
    line_alpha(grid_dist(lon, spacing), grad_lon, width_px, spacing, alpha),
    line_alpha(grid_dist(lat, spacing), grad_lat, width_px, spacing, alpha),
  );
}

fn geographic_graticule(lon: f32, lat: f32) -> f32 {
  if (!grid_enabled()) { return 0.0; }

  let grad_lon = angular_grad(lon);
  let grad_lat = length(vec2f(dpdx(lat), dpdy(lat)));

  let coarse = geo_tier(lon, lat, grad_lon, grad_lat, GEO_COARSE_SPACE, GRID_MAJOR_WIDTH, GRID_MAJOR_ALPHA);
  let mid = geo_tier(lon, lat, grad_lon, grad_lat, GEO_MID_SPACE, GRID_MINOR_WIDTH, GRID_MINOR_ALPHA);
  let fine = geo_tier(lon, lat, grad_lon, grad_lat, GEO_FINE_SPACE, GRID_MINOR_WIDTH, GRID_MINOR_ALPHA * 0.65);

  // Equator and prime meridian are solitary reference lines.
  let refs = max(
    line_alpha(abs(lon), grad_lon, GRID_REF_WIDTH, PI, GRID_REF_ALPHA),
    line_alpha(abs(lat), grad_lat, GRID_REF_WIDTH, PI, GRID_REF_ALPHA),
  );

  return max(max(coarse, mid), max(fine, refs));
}
