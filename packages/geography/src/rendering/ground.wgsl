struct Ground { @builtin(position) position: vec4f, @location(0) ndc: vec2f }
@vertex fn ground_vertex(@builtin(vertex_index) v: u32) -> Ground {
  let p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: Ground;
  out.position = vec4f(p[v], 0.0, 1.0);
  out.ndc = p[v];
  return out;
}
struct GroundOut { @location(0) color: vec4f, @builtin(frag_depth) depth: f32 }
/** The graticule's spacing in degrees: the nicest at least `px` CSS pixels apart. */
fn spacing(px: f32) -> f32 {
  let steps = array<f32, 12>(0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 5.0, 10.0, 15.0, 30.0);
  let wanted = px / max(projection_pixels(scene.projection), 0.000001);
  for (var i = 0u; i < 12u; i++) { if (steps[i] >= wanted) { return steps[i]; } }
  return 30.0;
}
/**
 * The ground under each pixel: the plane, the mercator plane, the tilted plane, or the globe, lit by
 * the sun, with the graticule over it and the atmosphere around the globe's rim. It writes the
 * ground's depth, so what lies behind the globe hides.
 */
@fragment fn ground_fragment(v: Ground) -> GroundOut {
  let q = scene.projection;
  var out: GroundOut;
  let right = vec3f(q.rotation.x, q.rotation.y, 0.0);
  let up = vec3f(-q.rotation.y * q.rotation.z, q.rotation.x * q.rotation.z, q.rotation.w);
  let front = vec3f(q.rotation.y * q.rotation.w, -q.rotation.x * q.rotation.w, q.rotation.z);
  let sx = v.ndc.x * q.view.x / (2.0 * q.pose.x);
  let sy = v.ndc.y * q.view.y / (2.0 * q.pose.x);
  var relative = vec2f(0.0);
  var depth = 0.999999;
  var hit = true;
  var rim = 0.0;
  if (q.view.w > 1.5) {
    let eye = front * q.pose.y;
    let direction = right * sx + up * sy - front * q.pose.y;
    let oc = eye + vec3f(0.0, 0.0, 1.0);
    let a = dot(direction, direction);
    let b = dot(oc, direction);
    let disc = b * b - a * (dot(oc, oc) - 1.0);
    if (disc < 0.0) {
      hit = false;
      // How near the ray passes the globe, past its rim, for the atmosphere.
      let t = -b / a;
      rim = length(oc + direction * t);
    } else {
      let world = eye + direction * ((-b - sqrt(disc)) / a);
      let n = world + vec3f(0.0, 0.0, 1.0);
      let sinLat = n.y * q.geo.y + n.z * q.geo.x;
      let toward = n.z * q.geo.y - n.y * q.geo.x;
      relative = vec2f(atan2(n.x, toward), asin(clamp(sinLat, -1.0, 1.0))) / DEGREE - vec2f(0.0, q.center.y);
      let clip = projection_clip(world, q);
      depth = clip.z / clip.w;
      rim = 1.0 - max(dot(normalize(n), -normalize(direction)), 0.0);
    }
  } else if (q.view.w > 0.5) {
    let eye = front * q.pose.y;
    let direction = right * sx + up * sy - front * q.pose.y;
    if (abs(direction.z) < 0.000001 || -eye.z / direction.z < 0.0) { hit = false; }
    else { relative = (eye + direction * (-eye.z / direction.z)).xy; }
  } else {
    relative = (right * sx + vec3f(-q.rotation.y, q.rotation.x, 0.0) * sy).xy;
    // On the mercator plane, back from where mercator stretches a latitude.
    if (q.geo.w > 1.5) { relative.y = projection_latitude(relative.y + q.pose.z) - q.center.y; }
  }
  var color = vec4f(u.surface.rgb * lightAt(relative), u.surface.a);
  if (u.graticule.a > 0.0) {
    let step = spacing(u.grid.x);
    let lines = relative / step;
    let width = max(fwidth(lines), vec2f(0.000001));
    let near = abs(fract((relative + q.center.xy) / step - 0.5) - 0.5) / width;
    let line = 1.0 - min(min(near.x, near.y), 1.0);
    color = vec4f(mix(color.rgb, u.graticule.rgb, line * u.graticule.a), color.a);
  }
  if (u.atmosphere.a > 0.0 && q.view.w > 1.5) {
    if (hit) {
      color = vec4f(mix(color.rgb, u.atmosphere.rgb, pow(rim, 3.0) * u.atmosphere.a), color.a);
    } else {
      let glow = pow(1.0 - smoothstep(1.0, 1.12, rim), 2.0) * u.atmosphere.a;
      out.color = vec4f(u.atmosphere.rgb * glow, glow);
      out.depth = 1.0;
      return out;
    }
  }
  if (!hit) { discard; }
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
