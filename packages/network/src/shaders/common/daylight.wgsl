// Shared solar-terminator lighting. Two policies, one terminator.
//
// daylight()         -> overlays (vertices, edges, poles, borders, graticule,
//                      earth axis). Stays readable on the night side; no limb
//                      darkening because overlays are 2D billboards, not lit
//                      surfaces.
//
// surface_daylight() -> opaque surfaces only (globe sphere, ground plane).
//                      Atmospheric: limb-darkened on the day side, dim on the
//                      night side.
//
// Both share the same `day` factor so overlay shading can never drift from
// the terminator the surface draws. They differ only in their floor and in
// whether they apply limb darkening.
//
// Lighting is world/time state (src/daylight.ts owns u.light_dir), so every
// projection family shades with the same sun. Families differ only in
// `sun_normal(world)` - the unit planet-center direction for a shaded point -
// supplied by the family's registry snippet: the globe normalizes its sphere
// positions, the plane converts its lon/lat coordinates through geo_to_xyz.
// FLAG_DAYLIGHT is set only for geographic topologies, so both functions
// return 1.0 (no shading) everywhere else.

// lon/lat degrees -> unit sphere, in the shared Y-up frame of camera/geo.ts
// (lon = atan2(-z, x)); the same frame sunDirection() emits u.light_dir in.
fn geo_to_xyz(lon: f32, lat: f32) -> vec3f {
  let la = radians(lat);
  let lo = radians(lon);
  let c = cos(la);
  return vec3f(c * cos(lo), sin(la), -c * sin(lo));
}

fn daylight(world: vec3f) -> f32 {
  if ((u.flags & FLAG_DAYLIGHT) == 0u) { return 1.0; }
  let ndotl = dot(sun_normal(world), u.light_dir);
  let day = smoothstep(-u.terminator_width, u.terminator_width, ndotl);
  return mix(u.night_floor, 1.0, day);
}

fn surface_daylight(world: vec3f) -> f32 {
  if ((u.flags & FLAG_DAYLIGHT) == 0u) { return 1.0; }
  let ndotl = dot(sun_normal(world), u.light_dir);
  let day  = smoothstep(-u.terminator_width, u.terminator_width, ndotl);
  let limb = mix(0.7, 1.0, clamp(ndotl, 0.0, 1.0));
  return mix(u.surface_night_floor, limb, day);
}
