// Shared solar-terminator lighting. Two policies, one terminator.
//
// daylight()         -> overlays (vertices, edges, poles, graticule).
//                      Stays readable on the night side; no limb darkening
//                      because overlays are 2D billboards, not lit surfaces.
//
// surface_daylight() -> sphere surface only. Atmospheric: limb-darkened on
//                      the day side, dim on the night side. Used by globe-bg.
//
// Both share the same `day` factor so the overlay shading can never drift
// from the terminator the surface draws. They differ only in their floor and
// in whether they apply limb darkening.
//
// Callers supply a unit vector pointing from origin to the shaded point (for
// the sphere surface this is the surface normal; for overlays it is the
// world-space position, also unit-length on the unit sphere).

fn daylight(world_dir: vec3f) -> f32 {
  if ((u.flags & FLAG_DAYLIGHT) == 0u) { return 1.0; }
  let ndotl = dot(world_dir, u.light_dir);
  let day = smoothstep(-u.terminator_width, u.terminator_width, ndotl);
  return mix(u.night_floor, 1.0, day);
}

fn surface_daylight(world_dir: vec3f) -> f32 {
  if ((u.flags & FLAG_DAYLIGHT) == 0u) { return 1.0; }
  let ndotl = dot(world_dir, u.light_dir);
  let day  = smoothstep(-u.terminator_width, u.terminator_width, ndotl);
  let limb = mix(0.7, 1.0, clamp(ndotl, 0.0, 1.0));
  return mix(u.surface_night_floor, limb, day);
}
