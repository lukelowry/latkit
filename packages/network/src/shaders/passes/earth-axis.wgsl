struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
}

struct ColorOut {
  @location(0) color: vec4f,
}

const EARTH_AXIS_RADIUS: f32 = 1.18;
const EARTH_AXIS_HALF_WIDTH_PX: f32 = 1.25;
const EARTH_AXIS_COLOR: vec3f = vec3f(0.78, 0.84, 0.92);
const EARTH_AXIS_ALPHA: f32 = 0.72;

fn axis_culled() -> VOut {
  var out: VOut;
  out.pos = vec4f(0.0, 0.0, 2.0, 1.0);
  out.uv = vec2f(0.0);
  out.color = vec4f(0.0);
  return out;
}

@vertex
fn vs(
  @builtin(vertex_index) vid: u32,
  @builtin(instance_index) inst: u32,
) -> VOut {
  let north = inst == 0u;
  let dir = select(vec3f(0.0, -1.0, 0.0), vec3f(0.0, 1.0, 0.0), north);

  let a = dir * (1.0 + GLOBE_SURFACE_OFFSET);
  let b = dir * EARTH_AXIS_RADIUS;

  let clip_a = u.vp * vec4f(a, 1.0);
  let clip_b = u.vp * vec4f(b, 1.0);

  // The screen-space ribbon expansion below is meaningless once an endpoint
  // reaches the camera plane, which a pitched low-altitude camera can do.
  if (clip_a.w <= MIN_CLIP_W || clip_b.w <= MIN_CLIP_W) {
    return axis_culled();
  }

  let screen_a = (clip_a.xy / clip_a.w * 0.5 + vec2f(0.5)) * u.viewport;
  let screen_b = (clip_b.xy / clip_b.w * 0.5 + vec2f(0.5)) * u.viewport;

  let seg = screen_b - screen_a;
  let len = length(seg);
  if (len < 0.5) {
    return axis_culled();
  }

  let tangent = seg / len;
  let normal = vec2f(-tangent.y, tangent.x);

  let t = f32(vid / 2u);
  let side = select(-1.0, 1.0, (vid % 2u) == 1u);
  let screen = mix(screen_a, screen_b, t) + normal * side * css_px(EARTH_AXIS_HALF_WIDTH_PX);

  let clip = mix(clip_a, clip_b, t);
  let ndc = screen * 2.0 / u.viewport - vec2f(1.0);

  var out: VOut;
  out.pos = vec4f(ndc * clip.w, clip.z, clip.w);
  out.uv = vec2f(side, t);
  out.color = vec4f(EARTH_AXIS_COLOR * daylight(dir), EARTH_AXIS_ALPHA);
  return out;
}

@fragment
fn fs_color(v: VOut) -> ColorOut {
  let aa = fwidth(v.uv.x);
  let alpha = 1.0 - smoothstep(1.0 - aa, 1.0, abs(v.uv.x));
  if (alpha < FRAGMENT_ALPHA_DISCARD) {
    discard;
  }
  return ColorOut(vec4f(v.color.rgb, v.color.a * alpha));
}
