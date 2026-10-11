struct Ground { @builtin(position) position: vec4f, @location(0) ndc: vec2f }
@vertex fn ground_vertex(@builtin(vertex_index) v: u32) -> Ground {
  let p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: Ground;
  out.position = vec4f(p[v], 0.0, 1.0);
  out.ndc = p[v];
  return out;
}
struct GroundOut { @location(0) color: vec4f, @builtin(frag_depth) depth: f32 }
/**
 * The ground under each pixel: the plane, the mercator plane, the tilted plane, or the globe, lit by
 * the sun, with the grid over it and the atmosphere around the globe's rim. It writes the ground's
 * depth, so what lies behind the globe hides.
 */
@fragment fn ground_fragment(v: Ground) -> GroundOut {
  let q = scene.projection;
  let g = projection_ground_point(v.ndc, q);
  var out: GroundOut;
  var depth = 0.999999;
  // How near the globe's rim the pixel lies, or past it how near its ray passes, for the atmosphere.
  var rim = 0.0;
  if (q.view.w > 1.5) {
    if (g.hit) {
      let clip = projection_clip(g.world, q);
      depth = clip.z / clip.w;
      rim = 1.0 - max(dot(normalize(g.world + vec3f(0.0, 0.0, 1.0)), -normalize(g.direction)), 0.0);
    } else {
      let oc = g.eye + vec3f(0.0, 0.0, 1.0);
      rim = length(oc - g.direction * (dot(oc, g.direction) / dot(g.direction, g.direction)));
    }
  }
  var color = vec4f(u.surface.rgb * lightAt(g.relative), u.surface.a);
  if (u.gridColor.a > 0.0) {
    color = vec4f(mix(color.rgb, u.gridColor.rgb, grid_lines(g.relative, u.grid) * u.gridColor.a), color.a);
  }
  if (u.atmosphere.a > 0.0 && q.view.w > 1.5) {
    if (g.hit) {
      color = vec4f(mix(color.rgb, u.atmosphere.rgb, pow(rim, 3.0) * u.atmosphere.a), color.a);
    } else {
      let glow = pow(1.0 - smoothstep(1.0, 1.12, rim), 2.0) * u.atmosphere.a;
      out.color = vec4f(u.atmosphere.rgb * glow, glow);
      out.depth = 1.0;
      return out;
    }
  }
  if (!g.hit) { discard; }
  out.color = premultiplied(color);
  out.depth = depth;
  return out;
}

struct Axis { @builtin(position) position: vec4f, @location(0) side: f32 }
/** The axis the globe turns on, through its poles and past them. */
@vertex fn axis_vertex(@builtin(vertex_index) v: u32) -> Axis {
  let q = scene.projection;
  let corners = array<vec2f, 6>(vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(0.0, 1.0), vec2f(0.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let c = corners[v];
  let north = vec3f(0.0, q.geo.y, q.geo.x) * 1.25;
  let a = projection_clip(-north - vec3f(0.0, 0.0, 1.0), q);
  let b = projection_clip(north - vec3f(0.0, 0.0, 1.0), q);
  let delta = (b.xy / b.w - a.xy / a.w) * q.view.xy;
  let normal = vec2f(-delta.y, delta.x) / max(length(delta), 0.001);
  var p = mix(a, b, c.x);
  p.x += normal.x * c.y * 2.0 / q.view.x * p.w;
  p.y += normal.y * c.y * 2.0 / q.view.y * p.w;
  var out: Axis;
  out.position = p;
  out.side = c.y;
  return out;
}
@fragment fn axis_fragment(v: Axis) -> @location(0) vec4f {
  return premultiplied(u.axis * vec4f(1.0, 1.0, 1.0, 1.0 - smoothstep(0.4, 1.0, abs(v.side))));
}
